const fs = require('fs');

const scenePath = 'assets/scene.before-black-white-checkerboard.scene';
const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));

const WHITE = '3032fa2f-3a27-42e9-a493-a5627df979ad';
const PINK = 'e388f7b0-6ebd-4c0f-a0e3-396f3a80092b';
const YELLOW = '4cef7b05-0762-4fa4-a910-df267ce3ad03';
const gameManagerNode = scene[24];
const shredderParent = scene[54];
const scenePrefabInfo = scene[86];
const roots = scenePrefabInfo.nestedPrefabInstanceRoots;

function cloneRange(start, end, parentId) {
  const outputStart = scene.length;
  const offset = outputStart - start;
  const remap = (value) => {
    if (Array.isArray(value)) return value.map(remap);
    if (!value || typeof value !== 'object') return value;
    const copy = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === '__id__' && typeof child === 'number' && child >= start && child <= end) copy[key] = child + offset;
      else copy[key] = remap(child);
    }
    return copy;
  };
  const clones = scene.slice(start, end + 1).map(remap);
  clones[0]._parent = { __id__: parentId };
  scene.push(...clones);
  roots.push({ __id__: outputStart });
  return outputStart;
}

function overrides(start, end, values) {
  for (let id = start; id <= end; id++) {
    const item = scene[id];
    if (item.__type__ !== 'CCPropertyOverrideInfo') continue;
    const key = item.propertyPath && item.propertyPath.join('.');
    if (key && Object.prototype.hasOwnProperty.call(values, key)) item.value = values[key];
  }
}

function makeContainer(name) {
  const id = scene.length;
  scene.push({
    __type__: 'cc.Node', _name: name, _objFlags: 0, __editorExtras__: {},
    _parent: { __id__: 24 }, _children: [], _active: true, _components: [], _prefab: null,
    _lpos: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
    _lrot: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 },
    _lscale: { __type__: 'cc.Vec3', x: 1, y: 1, z: 1 }, _mobility: 0, _layer: 1073741824,
    _euler: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 }, _id: `${name}-ReferenceLayout`,
  });
  gameManagerNode._children.push({ __id__: id });
  return id;
}

function setScale(rootId, scale) {
  const prefabInstance = scene[rootId + 2];
  const overrideId = scene.length;
  const targetInfoId = overrideId + 1;
  scene.push(
    { __type__: 'CCPropertyOverrideInfo', targetInfo: { __id__: targetInfoId }, propertyPath: ['_lscale'], value: { __type__: 'cc.Vec3', ...scale } },
    { __type__: 'cc.TargetInfo', localID: ['c46/YsCPVOJYA4mWEpNYRx'] },
  );
  prefabInstance.propertyOverrides.push({ __id__: overrideId });
}

function position(x, z) { return { __type__: 'cc.Vec3', x, y: 0, z }; }
function rotationBottom() { return { __type__: 'cc.Quat', x: 0, y: 1, z: 0, w: 0 }; }

// Keep the existing first white block and change the former black test block into pink.
scene[36]._name = 'PinkBlocks';
overrides(26, 35, { _name: 'White-01', _lpos: position(-4.8, 6.5), '_materials.0': { __uuid__: WHITE, __expectedType__: 'cc.Material' } });
overrides(37, 53, { _name: 'Pink-01', _lpos: position(-2.4, 6.5), '_materials.0': { __uuid__: PINK, __expectedType__: 'cc.Material' }, '_materials.1': { __uuid__: PINK, __expectedType__: 'cc.Material' } });
const yellowParent = makeContainer('YellowBlocks');

const whiteRoots = [26];
const pinkRoots = [37];
const yellowRoots = [];
const whitePositions = [[-4.8, 4.2], [-4.8, 1.9], [-4.8, -0.4], [-4.8, -2.7], [-2.4, -4.8], [0, -4.8], [2.4, -4.8], [4.8, -4.8], [4.8, 6.5], [4.8, 4.2], [4.8, 1.9], [4.8, -0.4], [4.8, -2.7]];
const pinkPositions = [[-2.4, 4.2], [-2.4, 1.9], [-2.4, -0.4], [-2.4, -2.7], [0, -2.7], [2.4, -2.7], [2.4, -0.4], [2.4, 1.9], [2.4, 4.2], [0, -4.8]];

for (let i = 0; i < whitePositions.length; i++) {
  const root = cloneRange(26, 35, 25);
  const [x, z] = whitePositions[i];
  overrides(root, root + 9, { _name: `White-${String(i + 2).padStart(2, '0')}`, _lpos: position(x, z), '_materials.0': { __uuid__: WHITE, __expectedType__: 'cc.Material' } });
  scene[25]._children.push({ __id__: root });
  whiteRoots.push(root);
}
for (let i = 0; i < pinkPositions.length; i++) {
  const root = cloneRange(26, 35, 36);
  const [x, z] = pinkPositions[i];
  overrides(root, root + 9, { _name: `Pink-${String(i + 2).padStart(2, '0')}`, _lpos: position(x, z), '_materials.0': { __uuid__: PINK, __expectedType__: 'cc.Material' } });
  scene[36]._children.push({ __id__: root });
  pinkRoots.push(root);
}

const yellowRoot = cloneRange(26, 35, yellowParent);
overrides(yellowRoot, yellowRoot + 9, { _name: 'Yellow-Centre', _lpos: position(0, 5.0), '_materials.0': { __uuid__: YELLOW, __expectedType__: 'cc.Material' } });
setScale(yellowRoot, { x: 2.4, y: 1, z: 4.2 });
scene[yellowParent]._children.push({ __id__: yellowRoot });
yellowRoots.push(yellowRoot);

// Bottom exits: existing white becomes White, existing black becomes Pink, and a yellow exit is cloned.
overrides(55, 67, { _name: 'White-Shredder', _lpos: { __type__: 'cc.Vec3', x: 4.8, y: 0.496, z: -10.529 }, _lrot: rotationBottom(), _euler: { __type__: 'cc.Vec3', x: 0, y: 180, z: 0 }, '_materials.0': { __uuid__: WHITE, __expectedType__: 'cc.Material' } });
overrides(68, 82, { _name: 'Pink-Shredder', _lpos: { __type__: 'cc.Vec3', x: -4.8, y: 0.496, z: -10.529 }, _lrot: rotationBottom(), _euler: { __type__: 'cc.Vec3', x: 0, y: 180, z: 0 }, '_materials.0': { __uuid__: PINK, __expectedType__: 'cc.Material' } });
const yellowGate = cloneRange(55, 67, 54);
overrides(yellowGate, yellowGate + 12, { _name: 'Yellow-Shredder', _lpos: { __type__: 'cc.Vec3', x: 0, y: 0.496, z: -10.529 }, _lrot: rotationBottom(), _euler: { __type__: 'cc.Vec3', x: 0, y: 180, z: 0 }, '_materials.0': { __uuid__: YELLOW, __expectedType__: 'cc.Material' } });
shredderParent._children.push({ __id__: yellowGate });

scene[84].elementId = 'White';
scene[84].blockNodes = whiteRoots.map((id) => ({ __id__: id }));
scene[84].targetShredders = [{ __id__: 55 }];
scene[85].elementId = 'Pink';
scene[85].blockNodes = pinkRoots.map((id) => ({ __id__: id }));
scene[85].targetShredders = [{ __id__: 68 }];
const yellowElementId = scene.length;
scene.push({ __type__: 'GameElement', elementId: 'Yellow', blockNodes: yellowRoots.map((id) => ({ __id__: id })), targetShredders: [{ __id__: yellowGate }] });
scene[83].elements = [{ __id__: 84 }, { __id__: 85 }, { __id__: yellowElementId }];

fs.writeFileSync(scenePath, `${JSON.stringify(scene, null, 2)}\n`);
