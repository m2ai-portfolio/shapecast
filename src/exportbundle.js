export function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'model'
  );
}

export function truncateRequest(text) {
  return String(text ?? '').slice(0, 2000);
}

export function readmeText({ list, result, layerUm }) {
  const size = result?.bbox ? result.bbox.size.map((v) => v.toFixed(2)).join(' x ') + ' mm' : 'n/a';
  const lines = [
    `ShapeCast export: ${list.name}`,
    '',
    'Target printer: Elegoo Saturn 3 (12K), slicer Chitubox. Units mm, Z up.',
    `Bounding box: ${size}`,
    `Suggested orientation: ${list.print.orientation}`,
    `Layer height: ${layerUm} um`,
    `Summed primitive volume: ${result ? (result.volumeMm3 / 1000).toFixed(1) : '?'} mL (upper bound; overlaps counted twice)`,
    '',
    'Assumptions made by the model:',
    ...(list.assumptions.length ? list.assumptions.map((a) => `- ${a}`) : ['- none']),
    '',
    'Print checks at export time:',
    ...(result?.checks ?? [])
      .filter((c) => c.level !== 'info')
      .map((c) => `- [${c.level}] ${c.message}`),
    '',
    'Open the .stl in Chitubox, keep the parts as one object, add supports where the checks say so, slice at the layer height above.',
  ];
  return lines.join('\n') + '\n';
}
