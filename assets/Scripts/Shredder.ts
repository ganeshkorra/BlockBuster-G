import {
    _decorator, Animation, AudioSource, BoxCollider, Color, Component, Material, MeshRenderer, Node,
    Mesh, ParticleSystem, Quat, Tween, tween, utils, primitives, Vec3,
} from 'cc';
import { Block } from './Block';
import { GameFeelAudio } from './GameFeelAudio';

const { ccclass } = _decorator;

/** Runtime presentation and matching logic for one coloured exit gate. */
@ccclass('Shredder')
export class Shredder extends Component {
    private area: Node | null = null;
    private particleNode: Node | null = null;
    private particles: ParticleSystem | null = null;
    private particleHomePosition = new Vec3();
    private particleHomeRotation = new Quat();
    private particleHomeScale = new Vec3(1, 1, 1);
    private particleBurstId = 0;
    private audio: AudioSource | null = null;
    private mesh: Node | null = null;
    private arrow: Node | null = null;
    private meshHomeScale = new Vec3(1, 1, 1);
    private arrowHomeScale = new Vec3(1, 1, 1);
    private debrisMesh: Mesh | null = null;
    private chipMaterial: Material | null = null;
    private exitGlow: Node | null = null;
    private exitGlowMaterial: Material | null = null;
    private static exitGlowMesh: Mesh | null = null;

    onLoad() {
        this.area = this.findChild('Area');
        this.particleNode = this.findChild('Particles');
        this.particles = this.particleNode?.getComponent(ParticleSystem) || this.getComponentInChildren(ParticleSystem) || null;
        if (this.particleNode) {
            this.particleHomePosition = this.particleNode.position.clone();
            this.particleHomeRotation = this.particleNode.rotation.clone();
            this.particleHomeScale = this.particleNode.scale.clone();
        }
        this.audio = this.getComponent(AudioSource);
        this.mesh = this.findChild('Mesh');
        this.arrow = this.findChild('Arrow');
        if (this.mesh) this.meshHomeScale.set(this.mesh.scale);
        if (this.arrow) this.arrowHomeScale.set(this.arrow.scale);
    }

    matches(block: Block): boolean {
        const blockMaterials = block.sharedMaterials();
        const targetMaterials = this.sharedMaterials();
        return blockMaterials.some((blockMaterial) => targetMaterials.some((targetMaterial) =>
            blockMaterial === targetMaterial ||
            (!!blockMaterial.uuid && blockMaterial.uuid === targetMaterial.uuid) ||
            (!!blockMaterial.name && blockMaterial.name === targetMaterial.name),
        ));
    }

    /** The designed Area trigger is used for gameplay; root collider is a fallback. */
    dropColliders(): BoxCollider[] {
        const areaColliders = this.area?.getComponentsInChildren(BoxCollider) || [];
        return areaColliders.length > 0 ? areaColliders : this.getComponentsInChildren(BoxCollider);
    }

    /** Matching block is near the gate, but has not yet reached its Area trigger. */
    setAnticipation(active: boolean, colour: Color | null) {
        GameFeelAudio.setGateHum(this.node.uuid, active);
        // A restrained repeating "breath" remains active through the intake.
        // Only visual children move; gate colliders and gameplay geometry stay fixed.
        this.setAnticipationPulse(this.mesh, this.meshHomeScale, active, 1.018);
        this.setAnticipationPulse(this.arrow, this.arrowHomeScale, active, 1.075);
    }

    /** Full, connected destruction sequence exactly at the outside rim. */
    playCrushFeedback(block: Block, exitWorld: Readonly<Vec3>, launchDirection: Readonly<Vec3>) {
        const sourceColour = this.blockColour(block) || new Color(255, 255, 255, 255);
        const glowColour = this.visibleEffectColour(sourceColour);
        const particleColour = this.opaqueParticleColour(sourceColour);
        this.setAnticipation(false, glowColour);
        this.playGateImpact(glowColour, exitWorld, launchDirection);
        this.playAuthoredParticles(exitWorld, launchDirection, particleColour);
        this.spawnSquareChips(block, exitWorld, launchDirection);
        this.audio?.play();
        GameFeelAudio.playCrushAndChips();
        this.getComponentInChildren(Animation)?.play();
    }

    private playGateImpact(colour: Color, exitWorld: Readonly<Vec3>, launchDirection: Readonly<Vec3>) {
        this.playExitGlow(colour, exitWorld, launchDirection);
        this.pulseNode(this.mesh, 1.045, 0.06, 0.15);
        this.pulseNode(this.arrow, 1.20, 0.06, 0.15);
    }

    /** Transparent colour strip at the exit only: outside the board, never a circular floor flare. */
    private playExitGlow(colour: Color, exitWorld: Readonly<Vec3>, launchDirection: Readonly<Vec3>) {
        const parent = this.node.parent || this.node;
        if (!this.exitGlow || !this.exitGlow.isValid) {
            this.exitGlow = new Node('RuntimeExitGlow');
            parent.addChild(this.exitGlow);
            const renderer = this.exitGlow.addComponent(MeshRenderer);
            if (!Shredder.exitGlowMesh) {
                Shredder.exitGlowMesh = utils.createMesh(primitives.plane({ width: 1, length: 1, widthSegments: 1, lengthSegments: 1 }));
            }
            renderer.mesh = Shredder.exitGlowMesh;
            this.exitGlowMaterial = new Material();
            this.exitGlowMaterial.initialize({ effectName: 'builtin-unlit', technique: 1 });
            renderer.setMaterial(this.exitGlowMaterial, 0);
        }
        const normal = new Vec3(launchDirection.x, 0, launchDirection.z);
        Vec3.normalize(normal, normal);
        this.exitGlow.setWorldPosition(new Vec3(exitWorld.x + normal.x * 0.18, exitWorld.y + 0.012, exitWorld.z + normal.z * 0.18));
        const rootCollider = this.getComponents(BoxCollider).find((collider) => !collider.isTrigger);
        const gateWidth = rootCollider ? (Math.abs(normal.z) > 0 ? rootCollider.size.x : rootCollider.size.z) : 2.2;
        const initial = Math.abs(normal.z) > 0 ? new Vec3(gateWidth * 0.72, 1, 0.34) : new Vec3(0.34, 1, gateWidth * 0.72);
        const final = Math.abs(normal.z) > 0 ? new Vec3(gateWidth * 1.04, 1, 1.08) : new Vec3(1.08, 1, gateWidth * 1.04);
        this.exitGlow.setScale(initial);
        this.exitGlow.active = true;
        const fade = { alpha: 82 };
        const setColour = () => this.exitGlowMaterial?.setProperty('mainColor', new Color(colour.r, colour.g, colour.b, fade.alpha));
        setColour();
        tween(fade).to(0.06, { alpha: 122 }, { onUpdate: setColour, easing: 'quadOut' }).to(0.20, { alpha: 0 }, { onUpdate: setColour, easing: 'quadIn' }).call(() => {
            if (this.exitGlow?.isValid) this.exitGlow.active = false;
        }).start();
        tween(this.exitGlow).to(0.26, { scale: final }, { easing: 'sineOut' }).start();
    }

    /** Uses the existing authored emitter, retimed as a short exit burst. */
    private playAuthoredParticles(exitWorld: Readonly<Vec3>, launchDirection: Readonly<Vec3>, colour: Color | null) {
        const particles = this.particles;
        const particleNode = this.particleNode;
        if (!particles || !particleNode) return;

        particleNode.setWorldPosition(exitWorld);
        const direction = new Vec3(launchDirection.x, 0.18, launchDirection.z);
        Vec3.normalize(direction, direction);
        const rotation = new Quat();
        Quat.rotationTo(rotation, new Vec3(0, -1, 0), direction);
        particleNode.setWorldRotation(rotation);
        particleNode.setScale(this.particleHomeScale.clone().multiplyScalar(0.72));
        particleNode.active = true;
        if (colour) particles.startColor.color = colour;
        particles.loop = false;
        particles.duration = 0.10;
        particles.startLifetime.constant = 0.40;
        particles.startSpeed.constant = 2.15;
        particles.startSize3D = true;
        particles.startSizeX.constant = 0.26;
        particles.startSizeY.constant = 0.13;
        particles.startSizeZ.constant = 0.26;
        particles.gravityModifier.constant = 0.70;
        particles.rateOverTime.constant = 70;
        particles.stop();
        particles.clear();
        particles.play();

        const burstId = ++this.particleBurstId;
        this.scheduleOnce(() => {
            if (burstId !== this.particleBurstId || !particleNode.isValid) return;
            particles.stop();
            particles.clear();
            particleNode.active = false;
            particleNode.setPosition(this.particleHomePosition);
            particleNode.setRotation(this.particleHomeRotation);
            particleNode.setScale(this.particleHomeScale);
        }, 0.56);
    }

    /** Code-built square chips make the same-material, tight brick fragments visible on every device. */
    private spawnSquareChips(block: Block, exitWorld: Readonly<Vec3>, launchDirection: Readonly<Vec3>) {
        if (!this.debrisMesh) this.debrisMesh = utils.createMesh(primitives.box());
        const parent = this.node.parent || this.node;
        const normal = new Vec3(launchDirection.x, 0, launchDirection.z);
        Vec3.normalize(normal, normal);
        const lateral = new Vec3(-normal.z, 0, normal.x);
        const chipColour = this.opaqueParticleColour(this.blockColour(block) || new Color(255, 255, 255, 255));
        const material = this.getChipMaterial(chipColour);
        const count = 10;
        for (let index = 0; index < count; index++) {
            const seed = (index + 1) * 17.13;
            const side = Math.sin(seed) * (0.18 + (index % 3) * 0.07);
            const arc = 0.13 + Math.abs(Math.cos(seed * 0.7)) * 0.19;
            const fall = 0.06 + (index % 4) * 0.022;
            const forward = 0.24 + ((index * 7) % 10) * 0.03;
            const size = index < 3
                ? 0.18 + index * 0.022
                : 0.10 + ((index * 3) % 4) * 0.022;
            const chip = new Node('RuntimeChip');
            parent.addChild(chip);
            chip.setWorldPosition(exitWorld);
            chip.setScale(size * 1.28, size * 0.52, size);
            const renderer = chip.addComponent(MeshRenderer);
            renderer.mesh = this.debrisMesh;
            renderer.setMaterial(material, 0);

            const startScale = chip.scale.clone();
            const motion = { t: 0 };
            tween(motion)
                .to(0.38, { t: 1 }, {
                    easing: 'linear',
                    onUpdate: () => {
                        const t = motion.t;
                        const outward = forward * (1 - Math.pow(1 - t, 2));
                        const sideways = side * (1 - Math.pow(1 - t, 2));
                        const height = arc * 4 * t * (1 - t) - fall * t * t;
                        const position = new Vec3(
                            exitWorld.x + normal.x * outward + lateral.x * sideways,
                            exitWorld.y + height,
                            exitWorld.z + normal.z * outward + lateral.z * sideways,
                        );
                        chip.setWorldPosition(position);
                        chip.setRotationFromEuler(seed * 9 * t, seed * 14 * t, seed * 6 * t);
                    },
                })
                .call(() => {
                    const fade = { amount: 1 };
                    tween(fade)
                        .to(0.10, { amount: 0 }, { onUpdate: () => chip.setScale(startScale.clone().multiplyScalar(fade.amount)) })
                        .call(() => { if (chip.isValid) chip.destroy(); })
                        .start();
                })
                .start();
        }
    }

    private pulseNode(node: Node | null, multiplier: number, inDuration: number, outDuration = 0.12) {
        if (!node) return;
        Tween.stopAllByTarget(node);
        const home = node.scale.clone();
        tween(node)
            .to(inDuration, { scale: home.clone().multiplyScalar(multiplier) }, { easing: 'quadOut' })
            .to(outDuration, { scale: home }, { easing: 'quadIn' })
            .start();
    }

    private setAnticipationPulse(node: Node | null, home: Readonly<Vec3>, active: boolean, multiplier: number) {
        if (!node) return;
        Tween.stopAllByTarget(node);
        const base = new Vec3(home.x, home.y, home.z);
        if (!active) {
            node.setScale(base);
            return;
        }
        node.setScale(base);
        tween(node)
            .to(0.18, { scale: base.clone().multiplyScalar(multiplier) }, { easing: 'sineInOut' })
            .to(0.22, { scale: base.clone() }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();
    }

    private sharedMaterials(): Material[] {
        const materials: Material[] = [];
        for (const renderer of this.getComponentsInChildren(MeshRenderer)) {
            for (let index = 0; index < renderer.sharedMaterials.length; index++) {
                const material = renderer.getSharedMaterial(index);
                if (material) materials.push(material);
            }
        }
        return materials;
    }

    private blockColour(block: Block): Color | null {
        for (const material of block.sharedMaterials()) {
            const value = material.getProperty('mainColor') as Color | null;
            if (value && typeof value.r === 'number') return new Color(value.r, value.g, value.b, value.a);
        }
        return null;
    }

    /** Flat unlit chips stay crisp and readable; they do not inherit the block's dark PBR shading. */
    private getChipMaterial(colour: Color) {
        if (!this.chipMaterial) {
            this.chipMaterial = new Material();
            this.chipMaterial.initialize({ effectName: 'builtin-unlit', technique: 0 });
        }
        this.chipMaterial.setProperty('mainColor', colour);
        return this.chipMaterial;
    }

    private visibleEffectColour(colour: Color) {
        return new Color(
            Math.max(72, Math.min(255, colour.r * 1.22 + 20)),
            Math.max(72, Math.min(255, colour.g * 1.22 + 20)),
            Math.max(84, Math.min(255, colour.b * 1.22 + 22)),
            255,
        );
    }

    /** Opaque block colour for fragments; very dark pieces remain dark but readable. */
    private opaqueParticleColour(colour: Color) {
        const brightness = (colour.r + colour.g + colour.b) / 3;
        if (brightness < 48) {
            return new Color(
                Math.max(28, colour.r),
                Math.max(31, colour.g),
                Math.max(36, colour.b),
                255,
            );
        }
        return new Color(
            Math.min(255, colour.r * 1.08 + 8),
            Math.min(255, colour.g * 1.08 + 8),
            Math.min(255, colour.b * 1.08 + 8),
            255,
        );
    }

    private findChild(name: string): Node | null {
        if (this.node.name === name) return this.node;
        const visit = (parent: Node): Node | null => {
            for (const child of parent.children) {
                if (child.name === name) return child;
                const result = visit(child);
                if (result) return result;
            }
            return null;
        };
        return visit(this.node);
    }

    onDestroy() {
        GameFeelAudio.stopGateHum(this.node.uuid);
    }
}
