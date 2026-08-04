const fs = require('fs');

const file = 'assets/White and Pink.scene';
const scene = JSON.parse(fs.readFileSync(file, 'utf8'));

// Reference layout on the real button-centre grid used by this scene.
// Top: two side columns around the 3 x 4 Yellow block.
// Middle: a five-button neck.
// Bottom: three complete, alternating checker rows.
const white = [
  [-4, 9], [6, 9], [-6, 7], [4, 7],
  [-4, 5], [6, 5], [-6, 3], [4, 3],
  [-4, 1], [0, 1], [4, 1],
  [-4, -1], [0, -1], [4, -1],
  [-6, -3], [-2, -3], [2, -3], [6, -3],
  [-4, -5], [0, -5], [4, -5],
];
const pink = [
  [-6, 9], [4, 9], [-4, 7], [6, 7],
  [-6, 5], [4, 5], [-4, 3], [6, 3],
  [-2, 1], [2, 1],
  [-6, -1], [-2, -1], [2, -1], [6, -1],
  [-4, -3], [0, -3], [4, -3],
  [-6, -5], [-2, -5], [2, -5], [6, -5],
];

function prefabOverrides(rootId) {
  const root = scene[rootId];
  const prefabInfo = scene[root._prefab.__id__];
  const instance = scene[prefabInfo.instance.__id__];
  return instance.propertyOverrides.map((entry) => scene[entry.__id__]);
}

function place(parentName, prefix, positions) {
  const parent = scene.find((item) => item?.__type__ === 'cc.Node' && item._name === parentName);
  if (!parent || parent._children.length !== positions.length) {
    throw new Error(`${parentName} must contain exactly ${positions.length} blocks.`);
  }
  parent._children.forEach((child, index) => {
    for (const override of prefabOverrides(child.__id__)) {
      const path = override.propertyPath?.join('.');
      if (path === '_name') override.value = `${prefix}${String(index + 1).padStart(2, '0')}`;
      if (path === '_lpos') {
        const [x, z] = positions[index];
        override.value = { __type__: 'cc.Vec3', x, y: 0, z };
      }
    }
  });
}

place('WhiteBlocks', 'White-', white);
place('PinkBlocks', 'Pink-', pink);

// Keep Yellow centred over the four upper rows of the reference layout.
const yellowName = scene.find((item) => item?.__type__ === 'CCPropertyOverrideInfo'
  && item.propertyPath?.join('.') === '_name' && item.value === 'Yellow-Centre');
if (yellowName) {
  const index = scene.indexOf(yellowName);
  const position = scene.slice(index + 1, index + 12)
    .find((item) => item?.__type__ === 'CCPropertyOverrideInfo' && item.propertyPath?.join('.') === '_lpos');
  if (position) position.value = { __type__: 'cc.Vec3', x: 0, y: 0, z: 6 };
}

fs.writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
