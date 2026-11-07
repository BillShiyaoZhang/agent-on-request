// The offline rehearsal uses a small, deterministic text comparison. Native
// agents propose their own correspondences. Both paths operate only on the
// definitions exchanged in the current task, never on acceptance fixtures.
const ignored = new Set('a an the and or of in on at for to from with within that this is are one by its as not'.split(' '));
const words = value => new Set(String(value).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
  .map(word => word.replace(/s$/, '')).filter(word => word.length > 2 && !ignored.has(word)));
const overlap = (left, right) => {
  const a = words(left), b = words(right), intersection = [...a].filter(word => b.has(word)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
};
export function guidedCorrespondences(own, peer) {
  const terms = ontology => ontology.modules.flatMap(module => module.concepts).filter(term =>
    /:(ResearchTopic|Decision|Presentation)$/.test(term.parent ?? ''));
  const candidates = terms(own).flatMap(source => terms(peer).map(target => ({ source: source.id, target: target.id,
    score: overlap(source.definition, target.definition), labelScore: overlap(source.label, target.label) })));
  return {
    proposed: candidates.filter(item => item.score >= 0.14).sort((a, b) => b.score - a.score).slice(0, 4)
      .map(({ source, target }) => ({ source, target, relation: 'conditional' })),
    disputed: candidates.filter(item => item.labelScore >= 0.45 && item.score < 0.08).slice(0, 1)
      .map(({ source, target }) => ({ source, target, relation: 'exact' })),
  };
}
