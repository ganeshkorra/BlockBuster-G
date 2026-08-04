const fs = require('fs');

const file = 'assets/scene.scene';
const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
const PINK = 'e388f7b0-6ebd-4c0f-a0e3-396f3a80092b';

const byName = (name) => scene.find((item) => item?.__type__ === 'cc.Node' && item._name === name);
const prefabOverrides = (rootId) => {
  const root = scene[rootId];
  const prefabInfo = scene[root._prefab.__id__];
  const instance = scene[prefabInfo.instance.__id__];
  return instance.propertyOverrides.map((entry) => scene[entry.__id__]);
};

function setRootNameAndMaterial(rootId, name, material) {
  for (const override of prefabOverrides(rootId)) {
    const path = override.propertyPath?.join('.');
    if (path === '_name') override.value = name;
    if (path === '_materials.0' || path === '_materials.1') {
      override.value = { __uuid__: material, __expectedType__: 'cc.Material' };
    }
  }
}

// This is a White/Pink level, so promote the old Black element, parent and
// shredder into their Pink equivalents while retaining their existing target
// references and collider setup.
const blackParent = byName('BlackBlocks');
blackParent._name = 'PinkBlocks';
const blackElement = scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === 'Black');
blackElement.elementId = 'Pink';
for (const child of blackParent._children) setRootNameAndMaterial(child.__id__, '', PINK);

const blackShredderName = scene.find((item) => item?.__type__ === 'CCPropertyOverrideInfo'
  && item.propertyPath?.join('.') === '_name' && item.value === 'Black-Shredder');
if (blackShredderName) {
  blackShredderName.value = 'Pink-Shredder';
  const shredderRoot = (() => {
    for (let index = scene.indexOf(blackShredderName); index >= 0; index--) {
      if (scene[index]?.__type__ === 'cc.Node' && scene[index]._prefab) return index;
    }
    return -1;
  })();
  if (shredderRoot >= 0) setRootNameAndMaterial(shredderRoot, 'Pink-Shredder', PINK);
}

function cloneBlock(parentName, elementId, name, position) {
  const parent = byName(parentName);
  const sourceRootIndex = parent._children[0].__id__;
  const sourceRoot = scene[sourceRootIndex];
  const sourceInfo = scene[sourceRoot._prefab.__id__];
  const sourceInstance = scene[sourceInfo.instance.__id__];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const rootIndex = scene.length;
  const prefabInfoIndex = rootIndex + 1;
  const instanceIndex = rootIndex + 2;
  const root = clone(sourceRoot);
  const info = clone(sourceInfo);
  const instance = clone(sourceInstance);
  root._parent = { __id__: scene.indexOf(parent) };
  root._prefab = { __id__: prefabInfoIndex };
  info.root = { __id__: rootIndex };
  info.instance = { __id__: instanceIndex };
  instance.propertyOverrides = [];
  scene.push(root, info, instance);

  for (const sourceRef of sourceInstance.propertyOverrides) {
    const override = clone(scene[sourceRef.__id__]);
    const targetInfo = clone(scene[override.targetInfo.__id__]);
    const overrideIndex = scene.length;
    override.targetInfo = { __id__: overrideIndex + 1 };
    const path = override.propertyPath?.join('.');
    if (path === '_name') override.value = name;
    if (path === '_lpos') override.value = { __type__: 'cc.Vec3', x: position[0], y: 0, z: position[1] };
    scene.push(override, targetInfo);
    instance.propertyOverrides.push({ __id__: overrideIndex });
  }
  parent._children.push({ __id__: rootIndex });
  scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === elementId).blockNodes.push({ __id__: rootIndex });
  return rootIndex;
}

const whiteParent = byName('WhiteBlocks');
const pinkParent = byName('PinkBlocks');
const whiteElement = scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === 'White');
const pinkElement = scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === 'Pink');

// Seven columns by ten rows: every board button gets exactly one block.
const whitePositions = [];
const pinkPositions = [];
for (let row = 0; row < 10; row++) {
  const z = 8 - row * 2;
  for (let column = 0; column < 7; column++) {
    const x = -6 + column * 2;
    const white = (row + column) % 2 === 0;
    (white ? whitePositions : pinkPositions).push([x, z]);
  }
}
// Make the top-row blocks line up directly with their two matching gates.
// Keep the colour totals balanced by swapping the companion corner cell.
const topWhiteAtFour = whitePositions.findIndex(([x, z]) => x === 4 && z === 8);
const topPinkAtFour = pinkPositions.findIndex(([x, z]) => x === 4 && z === 8);
if (topPinkAtFour >= 0) {
  const pinkCell = pinkPositions.splice(topPinkAtFour, 1)[0];
  const whiteCorner = whitePositions.findIndex(([x, z]) => x === 6 && z === 8);
  const cornerCell = whitePositions.splice(whiteCorner, 1)[0];
  whitePositions.push(pinkCell);
  pinkPositions.push(cornerCell);
}

function ensureCount(parent, element, prefix, positions) {
  for (let index = parent._children.length; index < positions.length; index++) {
    cloneBlock(parent._name, element.elementId, `${prefix}${String(index + 1).padStart(2, '0')}`, positions[index]);
  }
}

ensureCount(whiteParent, whiteElement, 'White-', whitePositions);
ensureCount(pinkParent, pinkElement, 'Pink-', pinkPositions);

function applyPositions(parent, positions, prefix) {
  parent._children.forEach((child, index) => {
    const [x, z] = positions[index];
    for (const override of prefabOverrides(child.__id__)) {
      const path = override.propertyPath?.join('.');
      if (path === '_name') override.value = `${prefix}${String(index + 1).padStart(2, '0')}`;
      if (path === '_lpos') override.value = { __type__: 'cc.Vec3', x, y: 0, z };
    }
  });
}

applyPositions(whiteParent, whitePositions, 'White-');
applyPositions(pinkParent, pinkPositions, 'Pink-');

const scenePrefabInfo = scene.find((item) => item?.__type__ === 'cc.PrefabInfo'
  && item.root === null && Array.isArray(item.nestedPrefabInstanceRoots));
for (const parent of [whiteParent, pinkParent]) {
  for (const child of parent._children) {
    if (!scenePrefabInfo.nestedPrefabInstanceRoots.some((entry) => entry.__id__ === child.__id__)) {
      scenePrefabInfo.nestedPrefabInstanceRoots.push({ __id__: child.__id__ });
    }
  }
}

fs.writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
