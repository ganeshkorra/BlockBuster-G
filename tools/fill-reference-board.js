const fs = require('fs');

const file = 'assets/scene.before-black-white-checkerboard.scene';
const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
const PINK = 'e388f7b0-6ebd-4c0f-a0e3-396f3a80092b';
const whiteParent = scene.findIndex((item) => item?.__type__ === 'cc.Node' && item._name === 'WhiteBlocks');
const pinkParent = scene.findIndex((item) => item?.__type__ === 'cc.Node' && item._name === 'PinkBlocks');
const whiteElement = scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === 'White');
const pinkElement = scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === 'Pink');
const scenePrefabInfo = scene.find((item) => item?.__type__ === 'cc.PrefabInfo' && item.root === null && Array.isArray(item.nestedPrefabInstanceRoots));

if (whiteElement.blockNodes.length !== 13 || pinkElement.blockNodes.length !== 12) {
  throw new Error('This fill script is intended to run once on the current reference layout.');
}

function cloneWhiteTemplate(parentId, name, material) {
  const sourceStart = 26;
  const sourceEnd = 35;
  const start = scene.length;
  const offset = start - sourceStart;
  const copy = (value) => {
    if (Array.isArray(value)) return value.map(copy);
    if (!value || typeof value !== 'object') return value;
    const clone = {};
    for (const [key, child] of Object.entries(value)) {
      clone[key] = key === '__id__' && typeof child === 'number' && child >= sourceStart && child <= sourceEnd ? child + offset : copy(child);
    }
    return clone;
  };
  const entries = scene.slice(sourceStart, sourceEnd + 1).map(copy);
  entries[0]._parent = { __id__: parentId };
  scene.push(...entries);
  scenePrefabInfo.nestedPrefabInstanceRoots.push({ __id__: start });
  for (let index = start; index <= start + (sourceEnd - sourceStart); index++) {
    const entry = scene[index];
    if (entry?.__type__ !== 'CCPropertyOverrideInfo') continue;
    const path = entry.propertyPath?.join('.');
    if (path === '_name') entry.value = name;
    if (path === '_materials.0') entry.value = { __uuid__: material, __expectedType__: 'cc.Material' };
  }
  scene[parentId]._children.push({ __id__: start });
  return start;
}

for (let index = 0; index < 8; index++) whiteElement.blockNodes.push({ __id__: cloneWhiteTemplate(whiteParent, `White-${String(index + 15).padStart(2, '0')}`, '3032fa2f-3a27-42e9-a493-a5627df979ad') });
for (let index = 0; index < 9; index++) pinkElement.blockNodes.push({ __id__: cloneWhiteTemplate(pinkParent, `Pink-${String(index + 13).padStart(2, '0')}`, PINK) });

fs.writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
