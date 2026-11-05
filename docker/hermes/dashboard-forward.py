"""Keep the native dashboard loopback-bound behind the published local port."""
import os
import socket
import socketserver
import threading


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            target = socket.create_connection(("127.0.0.1", int(os.environ.get("HERMES_DASHBOARD_PORT", "9119"))), timeout=5)
        except OSError:
            return
        target.settimeout(None)

        def relay(source, destination):
            try:
                while data := source.recv(65536):
                    destination.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    destination.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

        outgoing = threading.Thread(target=relay, args=(self.request, target), daemon=True)
        outgoing.start()
        relay(target, self.request)
        target.close()
        outgoing.join(timeout=1)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", int(os.environ.get("DEMO_DASHBOARD_FORWARD_PORT", "9129"))), Handler) as server:
        server.serve_forever()
