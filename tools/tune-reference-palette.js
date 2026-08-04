const fs = require('fs');

const file = 'assets/scene.before-black-white-checkerboard.scene';
const scene = JSON.parse(fs.readFileSync(file, 'utf8'));
const ambient = scene.find((item) => item?.__type__ === 'cc.AmbientInfo');
if (!ambient) throw new Error('Ambient settings were not found.');

// The old strong cyan sky light tinted white blocks blue, pink blocks purple,
// and yellow blocks olive. A low, neutral navy ambient lets the authored
// materials keep their intended hot-pink, warm-white, and gold colours.
ambient._skyColorHDR = { __type__: 'cc.Vec4', x: 0.07, y: 0.09, z: 0.20, w: 0.40 };
ambient._skyColor = { __type__: 'cc.Vec4', x: 0.07, y: 0.09, z: 0.20, w: 0.40 };
ambient._skyIllumHDR = 9000;
ambient._skyIllum = 9000;
ambient._groundAlbedoHDR = { __type__: 'cc.Vec4', x: 0.12, y: 0.11, z: 0.18, w: 1 };
ambient._groundAlbedo = { __type__: 'cc.Vec4', x: 0.12, y: 0.11, z: 0.18, w: 1 };
ambient._skyColorLDR = { __type__: 'cc.Vec4', x: 0.15, y: 0.17, z: 0.35, w: 0 };
ambient._skyIllumLDR = 0.32;
ambient._groundAlbedoLDR = { __type__: 'cc.Vec4', x: 0.16, y: 0.14, z: 0.22, w: 0 };

fs.writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
