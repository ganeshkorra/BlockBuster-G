const fs = require('fs');

const file = 'assets/scene.before-black-white-checkerboard.scene';
const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
// Read each row left-to-right: White, Pink, White, Pink. The next row starts
// with Pink, exactly like the checker pattern in the supplied reference.
// Exact board-button centres: 7 columns x 10 rows = 70 tile buttons.
// The 2-unit pitch and these centres match the positions manually set in the
// scene (for example X 4 / 6 and Z 9 / 7 / 5 on the upper-right buttons).
// Fill from the first (left) column across, with the same alternating pattern
// as the supplied reference. The two empty bottom rows preserve a path to the
// colour-matched shredders.
const white = [];
const pink = [];
function addCheckerRow(z, columns, startsWhite) {
  columns.forEach((x, index) => {
    const isWhite = startsWhite ? index % 2 === 0 : index % 2 !== 0;
    (isWhite ? white : pink).push([x, z]);
  });
}

// Yellow occupies the middle three buttons of the top four rows. Fill every
// other button around it.
addCheckerRow(9, [-6, -4, 4, 6], false);
addCheckerRow(7, [-6, -4, 4, 6], true);
addCheckerRow(5, [-6, -4, 4, 6], false);
addCheckerRow(3, [-6, -4, 4, 6], true);

// Fill all 42 buttons below the yellow section. The bottom row still places a
// Pink piece over its left intake and a White piece beside its right intake.
addCheckerRow(1,  [-6, -4, -2, 0, 2, 4, 6], false);
addCheckerRow(-1, [-6, -4, -2, 0, 2, 4, 6], true);
addCheckerRow(-3, [-6, -4, -2, 0, 2, 4, 6], false);
addCheckerRow(-5, [-6, -4, -2, 0, 2, 4, 6], true);
addCheckerRow(-7, [-6, -4, -2, 0, 2, 4, 6], false);
addCheckerRow(-9, [-6, -4, -2, 0, 2, 4, 6], true);

function cloneBlock(parentName, elementId, name) {
  const parentIndex = scene.findIndex((item) => item?.__type__ === 'cc.Node' && item._name === parentName);
  const parent = scene[parentIndex];
  const sourceRootIndex = parent._children[0].__id__;
  const sourceRoot = scene[sourceRootIndex];
  const sourcePrefabInfo = scene[sourceRoot._prefab.__id__];
  const sourceInstance = scene[sourcePrefabInfo.instance.__id__];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const rootIndex = scene.length;
  const prefabInfoIndex = rootIndex + 1;
  const instanceIndex = rootIndex + 2;
  const root = clone(sourceRoot);
  const prefabInfo = clone(sourcePrefabInfo);
  const instance = clone(sourceInstance);
  root._parent = { __id__: parentIndex };
  root._prefab = { __id__: prefabInfoIndex };
  prefabInfo.root = { __id__: rootIndex };
  prefabInfo.instance = { __id__: instanceIndex };
  instance.propertyOverrides = [];
  scene.push(root, prefabInfo, instance);

  for (const overrideRef of sourceInstance.propertyOverrides) {
    const override = clone(scene[overrideRef.__id__]);
    const targetInfo = clone(scene[override.targetInfo.__id__]);
    const overrideIndex = scene.length;
    const targetInfoIndex = overrideIndex + 1;
    override.targetInfo = { __id__: targetInfoIndex };
    if (override.propertyPath?.join('.') === '_name') override.value = name;
    scene.push(override, targetInfo);
    instance.propertyOverrides.push({ __id__: overrideIndex });
  }
  parent._children.push({ __id__: rootIndex });
  scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === elementId).blockNodes.push({ __id__: rootIndex });
}

function ensureBlockCount(parentName, elementId, prefix, expected) {
  const parent = scene.find((item) => item?.__type__ === 'cc.Node' && item._name === parentName);
  for (let number = parent._children.length + 1; number <= expected; number++) {
    cloneBlock(parentName, elementId, `${prefix}${String(number).padStart(2, '0')}`);
  }
}

// The original scene has 21 White + 21 Pink blocks. Filling all 58 available
// buttons needs 29 of each, so create the remaining 8 per colour as real
// scene nodes (not runtime-only copies).
ensureBlockCount('WhiteBlocks', 'White', 'White-', white.length);
ensureBlockCount('PinkBlocks', 'Pink', 'Pink-', pink.length);

// Cocos keeps an index of nested prefab roots in the scene asset. Register
// the newly created block nodes there as well, so they appear normally in the
// Hierarchy after the scene is reopened.
const scenePrefabInfo = scene.find((item) => item?.__type__ === 'cc.PrefabInfo'
  && item.root === null && Array.isArray(item.nestedPrefabInstanceRoots));
for (const parentName of ['WhiteBlocks', 'PinkBlocks']) {
  const parent = scene.find((item) => item?.__type__ === 'cc.Node' && item._name === parentName);
  for (const child of parent._children) {
    if (!scenePrefabInfo.nestedPrefabInstanceRoots.some((entry) => entry.__id__ === child.__id__)) {
      scenePrefabInfo.nestedPrefabInstanceRoots.push({ __id__: child.__id__ });
    }
  }
}

function turnLastWhiteIntoPink() {
  const whiteName = scene.find((item) => item?.__type__ === 'CCPropertyOverrideInfo' && item.propertyPath?.join('.') === '_name' && item.value === 'White-14');
  if (!whiteName) return;
  const nameIndex = scene.indexOf(whiteName);
  let rootIndex = -1;
  for (let index = nameIndex; index >= 0; index--) {
    if (scene[index]?.__type__ === 'cc.Node' && scene[index]._prefab && scene[index]._parent) { rootIndex = index; break; }
  }
  const whiteParent = scene.findIndex((item) => item?.__type__ === 'cc.Node' && item._name === 'WhiteBlocks');
  const pinkParent = scene.findIndex((item) => item?.__type__ === 'cc.Node' && item._name === 'PinkBlocks');
  scene[rootIndex]._parent = { __id__: pinkParent };
  scene[whiteParent]._children = scene[whiteParent]._children.filter((child) => child.__id__ !== rootIndex);
  scene[pinkParent]._children.push({ __id__: rootIndex });
  whiteName.value = 'Pink-12';
  for (const item of scene.slice(rootIndex, rootIndex + 12)) {
    if (item?.__type__ === 'CCPropertyOverrideInfo' && item.propertyPath?.join('.') === '_materials.0') item.value = { __uuid__: 'e388f7b0-6ebd-4c0f-a0e3-396f3a80092b', __expectedType__: 'cc.Material' };
  }
  const whiteElement = scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === 'White');
  const pinkElement = scene.find((item) => item?.__type__ === 'GameElement' && item.elementId === 'Pink');
  whiteElement.blockNodes = whiteElement.blockNodes.filter((block) => block.__id__ !== rootIndex);
  pinkElement.blockNodes.push({ __id__: rootIndex });
}

turnLastWhiteIntoPink();

function setPosition(prefix, positions) {
  const nameOverrides = scene.filter((item) => item && item.__type__ === 'CCPropertyOverrideInfo' && item.propertyPath?.join('.') === '_name' && new RegExp(`^${prefix}\\d+$`).test(String(item.value)));
  nameOverrides.sort((a, b) => String(a.value).localeCompare(String(b.value), undefined, { numeric: true }));
  if (nameOverrides.length !== positions.length) throw new Error(`${prefix}: expected ${positions.length}, found ${nameOverrides.length}`);
  for (let index = 0; index < nameOverrides.length; index++) {
    const nameIndex = scene.indexOf(nameOverrides[index]);
    const positionOverride = scene.slice(nameIndex + 1, nameIndex + 8).find((item) => item?.__type__ === 'CCPropertyOverrideInfo' && item.propertyPath?.join('.') === '_lpos');
    if (!positionOverride) throw new Error(`No position override for ${nameOverrides[index].value}`);
    const [x, z] = positions[index];
    positionOverride.value = { __type__: 'cc.Vec3', x, y: 0, z };
  }
}

setPosition('White-', white);
setPosition('Pink-', pink);

// Each block is a 2 x 2 tile piece. Keep its centre on the two-tile grid,
// but make the visible/collision footprint slightly smaller than the tile
// area. This is the 0.94 scale used in the scene screenshot: it makes every
// block sit *inside* the recessed tile buttons rather than touching them.
function setBlockTileScale(parentName) {
  const parentIndex = scene.findIndex((item) => item?.__type__ === 'cc.Node' && item._name === parentName);
  const parent = scene[parentIndex];
  for (const child of parent._children) {
    const rootIndex = child.__id__;
    const root = scene[rootIndex];
    const prefabInfo = scene[root._prefab.__id__];
    const prefabInstance = scene[prefabInfo.instance.__id__];
    const rootLocalId = 'c46/YsCPVOJYA4mWEpNYRx';
    let scaleOverrideIndex = prefabInstance.propertyOverrides
      .map((entry) => entry.__id__)
      .find((id) => {
        const override = scene[id];
        return override?.propertyPath?.join('.') === '_lscale'
          && scene[override.targetInfo.__id__]?.localID?.[0] === rootLocalId;
      });

    const scale = { __type__: 'cc.Vec3', x: 0.94, y: 1, z: 0.94 };
    if (scaleOverrideIndex !== undefined) {
      scene[scaleOverrideIndex].value = scale;
      continue;
    }

    scaleOverrideIndex = scene.length;
    scene.push({
      __type__: 'CCPropertyOverrideInfo',
      targetInfo: { __id__: scaleOverrideIndex + 1 },
      propertyPath: ['_lscale'],
      value: scale,
    });
    scene.push({ __type__: 'cc.TargetInfo', localID: [rootLocalId] });
    prefabInstance.propertyOverrides.push({ __id__: scaleOverrideIndex });
  }
}

setBlockTileScale('WhiteBlocks');
setBlockTileScale('PinkBlocks');

const yellowName = scene.find((item) => item?.__type__ === 'CCPropertyOverrideInfo' && item.propertyPath?.join('.') === '_name' && item.value === 'Yellow-Centre');
const yellowIndex = scene.indexOf(yellowName);
const yellowPosition = scene.slice(yellowIndex + 1, yellowIndex + 8).find((item) => item?.__type__ === 'CCPropertyOverrideInfo' && item.propertyPath?.join('.') === '_lpos');
yellowPosition.value = { __type__: 'cc.Vec3', x: 0, y: 0, z: 6.0 };

fs.writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
