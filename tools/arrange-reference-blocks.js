const fs = require('fs');

const file = 'assets/scene.before-black-white-checkerboard.scene';
const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
// Read each row left-to-right: White, Pink, White, Pink. The next row starts
// with Pink, exactly like the checker pattern in the supplied reference.
const rows = [
  // Two alternating columns on each side of the upper yellow block.
  { z: 8, x: [-5, -3, 3, 5], whiteFirst: true },
  { z: 6, x: [-5, -3, 3, 5], whiteFirst: false },
  { z: 4, x: [-5, -3, 3, 5], whiteFirst: true },
  { z: 2, x: [-5, -3, 3, 5], whiteFirst: false },
  // The layout narrows beneath the blocked yellow piece.
  { z: 0, x: [-3, -1, 1, 3], whiteFirst: false },
  { z: -2, x: [-3, -1, 1, 3], whiteFirst: true },
  // Then opens into the wide lower section.
  { z: -4, x: [-5, -3, -1, 1, 3, 5], whiteFirst: true },
  { z: -6, x: [-5, -3, -1, 1, 3, 5], whiteFirst: false },
  { z: -8, x: [-5, -3, -1, 1, 3, 5], whiteFirst: true },
];
const white = [];
const pink = [];
for (const row of rows) {
  row.x.forEach((x, column) => {
    const target = (column % 2 === 0) === row.whiteFirst ? white : pink;
    target.push([x, row.z]);
  });
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

const yellowName = scene.find((item) => item?.__type__ === 'CCPropertyOverrideInfo' && item.propertyPath?.join('.') === '_name' && item.value === 'Yellow-Centre');
const yellowIndex = scene.indexOf(yellowName);
const yellowPosition = scene.slice(yellowIndex + 1, yellowIndex + 8).find((item) => item?.__type__ === 'CCPropertyOverrideInfo' && item.propertyPath?.join('.') === '_lpos');
yellowPosition.value = { __type__: 'cc.Vec3', x: 0, y: 0, z: 6.0 };

fs.writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
