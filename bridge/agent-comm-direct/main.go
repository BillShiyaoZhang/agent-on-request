package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/BillShiyaoZhang/agent-comm/agent"
	"github.com/BillShiyaoZhang/agent-comm/crypto"
	pb "github.com/BillShiyaoZhang/agent-comm/proto"
	"github.com/BillShiyaoZhang/agent-comm/session"
	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/control"
	libp2pcrypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/libp2p/go-libp2p/p2p/transport/tcp"
	"github.com/multiformats/go-multiaddr"
	"google.golang.org/protobuf/proto"
)

const (
	maxPayloadBytes = 512 * 1024
	maxLineBytes    = 6*maxPayloadBytes + 1024 // JSON can escape one byte as six characters.
	deliveryTimeout = 4 * time.Second
	directProtocol  = "DIRECT_PROTOCOL"
	peerOffline     = "PEER_OFFLINE"
	runtimeTimeout  = "RUNTIME_TIMEOUT"
)

var (
	requestID       = regexp.MustCompile(`^[a-zA-Z0-9._:-]{1,128}$`)
	loopbackAddress = regexp.MustCompile(`^/ip4/127\.0\.0\.1/tcp/[1-9][0-9]{0,4}$`)
)

type request struct {
	ID      string `json:"id"`
	From    string `json:"from"`
	Payload string `json:"payload"`
}

type response struct {
	ID      string `json:"id"`
	OK      bool   `json:"ok"`
	Payload string `json:"payload,omitempty"`
	Code    string `json:"code,omitempty"`
}

type peerInfo struct {
	Address string `json:"address"`
	PeerID  string `json:"peerId"`
	URN     string `json:"urn"`
}

type endpoint struct {
	identity *agent.Agent
	receipts string
	remote   *endpoint
	done     <-chan struct{}

	mu      sync.Mutex
	pending *delivery
}

type delivery struct {
	wireID       string
	digest       [sha256.Size]byte
	plaintext    string
	acknowledged bool
}

func newEndpoint(dir string) (*endpoint, error) {
	keys := filepath.Join(dir, "keys")
	receipts := filepath.Join(dir, "receipts")
	for _, path := range []string{keys, receipts} {
		if err := os.MkdirAll(path, 0700); err != nil {
			return nil, err
		}
	}
	identity, err := crypto.LoadOrCreateIdentity(keys)
	if err != nil {
		return nil, err
	}
	return &endpoint{identity: &agent.Agent{Keys: identity}, receipts: receipts}, nil
}

// The generic SDK host enables AutoNAT and inherits libp2p relay defaults.
// Build a TCP-only host for the SDK session, with exactly one local peer.
func (e *endpoint) listen(remote *endpoint) error {
	remoteID, err := agent.PeerIDFromEd25519PK(remote.identity.Keys.Ed25519.PublicKey)
	if err != nil {
		return err
	}
	privateKey, err := libp2pcrypto.UnmarshalEd25519PrivateKey(e.identity.Keys.Ed25519.PrivateKey)
	if err != nil {
		return err
	}
	host, err := libp2p.New(libp2p.Identity(privateKey), libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"),
		libp2p.NoTransports, libp2p.Transport(tcp.NewTCPTransport), libp2p.DisableRelay(),
		libp2p.ConnectionGater(loopbackPeer{remoteID}),
	)
	if err != nil {
		return err
	}
	e.identity.Host = host
	e.identity.Session = session.NewManager(host, e.identity.Keys)
	e.remote = remote
	return nil
}

type loopbackPeer struct{ id peer.ID }

func (p loopbackPeer) InterceptPeerDial(id peer.ID) bool { return id == p.id }

func (p loopbackPeer) InterceptAddrDial(id peer.ID, address multiaddr.Multiaddr) bool {
	return id == p.id && loopbackAddress.MatchString(address.String())
}

func (loopbackPeer) InterceptAccept(connection network.ConnMultiaddrs) bool {
	return loopbackAddress.MatchString(connection.RemoteMultiaddr().String())
}

func (p loopbackPeer) InterceptSecured(_ network.Direction, id peer.ID, connection network.ConnMultiaddrs) bool {
	return p.InterceptAddrDial(id, connection.RemoteMultiaddr())
}

func (loopbackPeer) InterceptUpgraded(network.Conn) (bool, control.DisconnectReason) {
	return true, 0 // The address and authenticated peer ID were checked during upgrade.
}

func (e *endpoint) info() peerInfo {
	identity := e.identity
	return peerInfo{
		Address: identity.Host.Addrs()[0].String(),
		PeerID:  identity.Host.ID().String(),
		URN:     identity.Keys.Ed25519.URN(),
	}
}

func (e *endpoint) receive(envelope *pb.EncryptedEnvelope, data []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	pending := e.pending
	if pending == nil || envelope.MessageId != pending.wireID ||
		envelope.SenderUrn != e.remote.identity.Keys.Ed25519.URN() ||
		envelope.RecipientUrn != e.identity.Keys.Ed25519.URN() ||
		!bytes.Equal(envelope.SenderStaticPubkey, e.remote.identity.Keys.X25519PK) {
		return errors.New("unexpected peer or operation")
	}
	var message pb.ChatMessage
	if err := proto.Unmarshal(data, &message); err != nil || message.GetText() == nil {
		return errors.New("invalid peer message")
	}
	plaintext := message.GetText().Text
	if sha256.Sum256([]byte(plaintext)) != pending.digest {
		return errors.New("unexpected peer payload")
	}
	if err := e.persistReceipt(pending.wireID, pending.digest); err != nil {
		return err
	}
	pending.plaintext = plaintext
	pending.acknowledged = true
	return nil
}

func (e *endpoint) persistReceipt(wireID string, digest [sha256.Size]byte) error {
	// The native durable callback must commit before it returns. The pinned
	// sender is bound into wireID. Keep only the latest receipt per endpoint.
	// The application owns history and deduplication for older operations.
	path := filepath.Join(e.receipts, "latest")
	record := append([]byte(wireID), digest[:]...)
	previous, err := os.ReadFile(path)
	if err == nil {
		if bytes.Equal(previous, record) {
			return nil
		}
		if len(previous) != len(record) || bytes.Equal(previous[:len(wireID)], record[:len(wireID)]) {
			return errors.New("operation conflicts with receipt")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.CreateTemp(e.receipts, ".pending-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(record)
	if err := errors.Join(writeErr, file.Sync(), file.Close()); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func transfer(ctx context.Context, from, to *endpoint, input request) (string, string) {
	ctx, cancel := context.WithTimeout(ctx, deliveryTimeout)
	defer cancel()

	// Stable native ID across explicit retries. There is no autonomous outbox.
	identity := from.identity
	key := sha256.Sum256([]byte(identity.Keys.Ed25519.URN() + "\x00" + input.ID))
	pending := &delivery{wireID: hex.EncodeToString(key[:]), digest: sha256.Sum256([]byte(input.Payload))}
	envelope, err := identity.Session.BuildEnvelopeForRecipient(
		to.identity.Keys.Ed25519.URN(), to.identity.Keys.X25519PK, input.Payload, pending.wireID,
	)
	if err != nil {
		return "", directProtocol
	}
	to.mu.Lock()
	if to.pending != nil {
		to.mu.Unlock()
		return "", directProtocol
	}
	to.pending = pending
	to.mu.Unlock()
	defer func() {
		to.mu.Lock()
		to.pending = nil
		to.mu.Unlock()
	}()

	target := peer.AddrInfo{ID: to.identity.Host.ID(), Addrs: to.identity.Host.Addrs()}
	if err := identity.Host.Connect(ctx, target); err != nil {
		return "", failureCode(ctx, err, peerOffline)
	}
	if err := sendEnvelope(ctx, identity, target.ID, envelope); err != nil {
		return "", failureCode(ctx, err, directProtocol)
	}
	to.mu.Lock()
	defer to.mu.Unlock()
	if !pending.acknowledged {
		return "", directProtocol
	}
	return pending.plaintext, ""
}

func failureCode(ctx context.Context, err error, fallback string) string {
	var networkError net.Error
	if ctx.Err() != nil || errors.As(err, &networkError) && networkError.Timeout() {
		return runtimeTimeout
	}
	return fallback
}

func sendEnvelope(ctx context.Context, sender *agent.Agent, recipient peer.ID, envelope *pb.EncryptedEnvelope) error {
	stream, err := sender.Host.NewStream(ctx, recipient, protocol.ID(session.ProtoID))
	if err != nil {
		return err
	}
	defer stream.Close()
	deadline, _ := ctx.Deadline()
	if err := stream.SetDeadline(deadline); err != nil {
		return err
	}
	// agent-comm exports its signed envelope builder and frame reader. Its
	// stream writer is private and the convenience sender chooses a new ID.
	encoded, err := proto.Marshal(envelope)
	if err != nil || len(encoded) == 0 || len(encoded) > crypto.MaxEnvelopeSize {
		return errors.New("invalid outgoing envelope")
	}
	frame := binary.BigEndian.AppendUint32(make([]byte, 0, 4+len(encoded)), uint32(len(encoded)))
	frame = append(frame, encoded...)
	if _, err := io.Copy(stream, bytes.NewReader(frame)); err != nil {
		return err
	}
	if err := stream.CloseWrite(); err != nil {
		return err
	}
	ack, err := session.ReadEnvelope(stream)
	if err != nil {
		return err
	}
	if err := session.VerifyPeerURN(recipient, ack.SenderUrn); err != nil {
		return err
	}
	plaintext, err := sender.Session.DecryptEnvelope(ack)
	if err != nil {
		return err
	}
	var reply pb.ChatMessage
	if err := proto.Unmarshal(plaintext, &reply); err != nil || reply.GetText().GetText() != "persisted" {
		return errors.New("invalid durable peer acknowledgment")
	}
	return nil
}

func run(ctx context.Context, dir string, stdin io.Reader, stdout io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	var endpoints []*endpoint
	defer func() {
		cancel()
		for _, endpoint := range endpoints {
			if endpoint.done != nil {
				<-endpoint.done
			}
			_ = endpoint.identity.Close()
		}
	}()
	for _, name := range []string{"alice", "bob"} {
		endpoint, err := newEndpoint(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		endpoints = append(endpoints, endpoint)
	}
	alice, bob := endpoints[0], endpoints[1]
	if err := alice.listen(bob); err != nil {
		return err
	}
	if err := bob.listen(alice); err != nil {
		return err
	}
	for _, endpoint := range endpoints {
		endpoint.done = endpoint.identity.StartListeningDurable(ctx, endpoint.receive)
	}
	peers := map[string]peerInfo{"Alice": alice.info(), "Bob": bob.info()}
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(struct {
		Ready bool                `json:"ready"`
		Peers map[string]peerInfo `json:"peers"`
	}{true, peers}); err != nil {
		return err
	}

	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 4096), maxLineBytes)
	for ctx.Err() == nil && scanner.Scan() {
		var input request
		line := scanner.Bytes()
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.DisallowUnknownFields()
		err := decoder.Decode(&input)
		result := response{ID: input.ID, Code: directProtocol}
		if !requestID.MatchString(input.ID) {
			result.ID = ""
		} else if err == nil && utf8.Valid(line) && json.Valid(line) &&
			len(input.Payload) > 0 && len(input.Payload) <= maxPayloadBytes {
			switch input.From {
			case "Alice":
				result.Payload, result.Code = transfer(ctx, alice, bob, input)
			case "Bob":
				result.Payload, result.Code = transfer(ctx, bob, alice, input)
			}
			result.OK = result.Code == ""
		}
		if err := encoder.Encode(result); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		_ = os.Stdin.Close()
	}()
	if err := run(ctx, ".", os.Stdin, os.Stdout); err != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, "agent-comm direct bridge failed")
		os.Exit(1)
	}
}
