const fs = require('fs');

const file = 'assets/White and Pink.scene';
const scene = JSON.parse(fs.readFileSync(file, 'utf8'));

function parent(name) {
  return scene.find((item) => item?.__type__ === 'cc.Node' && item._name === name);
}

function cloneBlock(sourceRootId, destinationParent, blockName, x, z) {
  const sourceRoot = scene[sourceRootId];
  const sourceInfo = scene[sourceRoot._prefab.__id__];
  const sourceInstance = scene[sourceInfo.instance.__id__];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const rootId = scene.length;
  const infoId = rootId + 1;
  const instanceId = rootId + 2;
  const root = clone(sourceRoot);
  const info = clone(sourceInfo);
  const instance = clone(sourceInstance);
  root._parent = { __id__: scene.indexOf(destinationParent) };
  root._prefab = { __id__: infoId };
  info.root = { __id__: rootId };
  info.instance = { __id__: instanceId };
  instance.propertyOverrides = [];
  scene.push(root, info, instance);

  for (const sourceRef of sourceInstance.propertyOverrides) {
    const override = clone(scene[sourceRef.__id__]);
    const targetInfo = clone(scene[override.targetInfo.__id__]);
    const overrideId = scene.length;
    override.targetInfo = { __id__: overrideId + 1 };
    const path = override.propertyPath?.join('.');
    if (path === '_name') override.value = blockName;
    if (path === '_lpos') override.value = { __type__: 'cc.Vec3', x, y: 0, z };
    scene.push(override, targetInfo);
    instance.propertyOverrides.push({ __id__: overrideId });
  }
  destinationParent._children.push({ __id__: rootId });
  return rootId;
}

const whiteParent = parent('WhiteBlocks');
const pinkParent = parent('PinkBlocks');
const whiteElement = scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === 'White');
const pinkElement = scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === 'Pink');
if (whiteParent._children.length !== 21 || pinkParent._children.length !== 21) {
  throw new Error('This bottom-row fill expects the 21 White + 21 Pink reference layout.');
}

// Continue the checker sequence across the two bottom rows.
const whitePositions = [[-6, -7], [-2, -7], [2, -7], [6, -7], [-4, -9], [0, -9], [4, -9]];
const pinkPositions = [[-4, -7], [0, -7], [4, -7], [-6, -9], [-2, -9], [2, -9], [6, -9]];

for (let index = 0; index < 7; index++) {
  const [x, z] = whitePositions[index];
  whiteElement.blockNodes.push({ __id__: cloneBlock(whiteParent._children[0].__id__, whiteParent, `White-${String(index + 23).padStart(2, '0')}`, x, z) });
}
for (let index = 0; index < 7; index++) {
  const [x, z] = pinkPositions[index];
  pinkElement.blockNodes.push({ __id__: cloneBlock(pinkParent._children[0].__id__, pinkParent, `Pink-${String(index + 22).padStart(2, '0')}`, x, z) });
}

const scenePrefabInfo = scene.find((item) => item?.__type__ === 'cc.PrefabInfo'
  && item.root === null && Array.isArray(item.nestedPrefabInstanceRoots));
for (const blockParent of [whiteParent, pinkParent]) {
  for (const child of blockParent._children) {
    if (!scenePrefabInfo.nestedPrefabInstanceRoots.some((entry) => entry.__id__ === child.__id__)) {
      scenePrefabInfo.nestedPrefabInstanceRoots.push({ __id__: child.__id__ });
    }
  }
}

fs.writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
