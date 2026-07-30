import {
    _decorator, Animation, AudioSource, BoxCollider, Color, Component, Material, MeshRenderer, Node,
    Mesh, ParticleSystem, Quat, SphereLight, Tween, tween, utils, primitives, Vec3,
} from 'cc';
import { Block } from './Block';

const { ccclass } = _decorator;

/** Runtime presentation and matching logic for one coloured exit gate. */
@ccclass('Shredder')
export class Shredder extends Component {
    private area: Node | null = null;
    private particleNode: Node | null = null;
    private particles: ParticleSystem | null = null;
    private audio: AudioSource | null = null;
    private mesh: Node | null = null;
    private arrow: Node | null = null;
    private glowNode: Node | null = null;
    private glow: SphereLight | null = null;
    private debrisMesh: Mesh | null = null;

    onLoad() {
        this.area = this.findChild('Area');
        this.particleNode = this.findChild('Particles');
        this.particles = this.particleNode?.getComponent(ParticleSystem) || this.getComponentInChildren(ParticleSystem) || null;
        this.audio = this.getComponent(AudioSource);
        this.mesh = this.findChild('Mesh');
        this.arrow = this.findChild('Arrow');
        this.createRuntimeGlow();
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
        if (!this.glow || !this.glowNode) return;
        Tween.stopAllByTarget(this.glow);
        if (colour) this.glow.color = colour;
        this.glowNode.active = active;
        tween(this.glow)
            .to(active ? 0.10 : 0.08, { luminance: active ? 18000 : 0 }, { easing: active ? 'quadOut' : 'quadIn' })
            .call(() => { if (!active && this.glowNode?.isValid) this.glowNode.active = false; })
            .start();

        // Pulse only visual children. Gate colliders stay stable throughout drag.
        this.pulseNode(this.mesh, active ? 1.025 : 1, active ? 0.10 : 0.08);
        this.pulseNode(this.arrow, active ? 1.10 : 1, active ? 0.10 : 0.08);
    }

    /** Full, connected destruction sequence exactly at the outside rim. */
    playCrushFeedback(block: Block, exitWorld: Readonly<Vec3>, launchDirection: Readonly<Vec3>) {
        const colour = this.blockColour(block);
        this.setAnticipation(false, colour);
        this.playGateImpact(colour);
        this.playAuthoredParticles(exitWorld, launchDirection, colour);
        this.spawnSquareChips(block, exitWorld, launchDirection);
        this.audio?.play();
        this.getComponentInChildren(Animation)?.play();
    }

    private createRuntimeGlow() {
        const existing = this.findChild('RuntimeGateGlow');
        this.glowNode = existing || new Node('RuntimeGateGlow');
        if (!existing) this.node.addChild(this.glowNode);
        this.glowNode.setPosition(0, 0.35, 0);
        this.glow = this.glowNode.getComponent(SphereLight) || this.glowNode.addComponent(SphereLight);
        this.glow.range = 4.5;
        this.glow.luminance = 0;
        this.glowNode.active = false;
    }

    private playGateImpact(colour: Color | null) {
        if (this.glow && this.glowNode) {
            Tween.stopAllByTarget(this.glow);
            this.glow.color = colour || new Color(255, 255, 255, 255);
            this.glowNode.active = true;
            tween(this.glow)
                .to(0.045, { luminance: 62000 }, { easing: 'quadOut' })
                .to(0.20, { luminance: 0 }, { easing: 'quadIn' })
                .call(() => { if (this.glowNode?.isValid) this.glowNode.active = false; })
                .start();
        }
        this.pulseNode(this.mesh, 1.045, 0.06, 0.15);
        this.pulseNode(this.arrow, 1.20, 0.06, 0.15);
    }

    /** Uses the existing authored emitter, retimed as a short exit burst. */
    private playAuthoredParticles(exitWorld: Readonly<Vec3>, launchDirection: Readonly<Vec3>, colour: Color | null) {
        const particles = this.particles;
        const particleNode = this.particleNode;
        if (!particles || !particleNode) return;

        const homePosition = particleNode.position.clone();
        const homeRotation = particleNode.rotation.clone();
        particleNode.setWorldPosition(exitWorld);
        const direction = new Vec3(launchDirection.x, 0.18, launchDirection.z);
        Vec3.normalize(direction, direction);
        const rotation = new Quat();
        Quat.rotationTo(rotation, new Vec3(0, -1, 0), direction);
        particleNode.setWorldRotation(rotation);
        particleNode.active = true;
        if (colour) particles.startColor.color = colour;
        particles.loop = false;
        particles.duration = 0.20;
        particles.startLifetime.constant = 0.34;
        particles.startSpeed.constant = 2.7;
        particles.gravityModifier.constant = 0.35;
        particles.rateOverTime.constant = 65;
        particles.stop();
        particles.clear();
        particles.play();

        this.scheduleOnce(() => {
            if (!particleNode.isValid) return;
            particles.stop();
            particles.clear();
            particleNode.active = false;
            particleNode.setPosition(homePosition);
            particleNode.setRotation(homeRotation);
        }, 0.62);
    }

    /** Code-built square chips make the same-material, tight brick fragments visible on every device. */
    private spawnSquareChips(block: Block, exitWorld: Readonly<Vec3>, launchDirection: Readonly<Vec3>) {
        const material = block.sharedMaterials()[0];
        if (!material) return;
        if (!this.debrisMesh) this.debrisMesh = utils.createMesh(primitives.box());
        const parent = this.node.parent || this.node;
        const normal = new Vec3(launchDirection.x, 0, launchDirection.z);
        Vec3.normalize(normal, normal);
        const lateral = new Vec3(-normal.z, 0, normal.x);
        const count = 12;
        for (let index = 0; index < count; index++) {
            const seed = (index + 1) * 17.13;
            const side = Math.sin(seed) * 0.58;
            const lift = 0.08 + Math.abs(Math.cos(seed * 0.7)) * 0.38;
            const forward = 0.20 + ((index * 7) % 10) * 0.042;
            const size = 0.10 + ((index * 3) % 4) * 0.035;
            const chip = new Node('RuntimeChip');
            parent.addChild(chip);
            chip.setWorldPosition(exitWorld);
            chip.setScale(size * 1.35, size * 0.62, size);
            const renderer = chip.addComponent(MeshRenderer);
            renderer.mesh = this.debrisMesh;
            renderer.setMaterial(material, 0);

            const destination = new Vec3(
                exitWorld.x + normal.x * forward + lateral.x * side,
                exitWorld.y + lift,
                exitWorld.z + normal.z * forward + lateral.z * side,
            );
            const startScale = chip.scale.clone();
            const motion = { t: 0 };
            tween(motion)
                .to(0.30, { t: 1 }, {
                    easing: 'quadOut',
                    onUpdate: () => {
                        const position = new Vec3();
                        Vec3.lerp(position, exitWorld, destination, motion.t);
                        chip.setWorldPosition(position);
                        chip.setRotationFromEuler(seed * 12 * motion.t, seed * 19 * motion.t, seed * 8 * motion.t);
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
}
