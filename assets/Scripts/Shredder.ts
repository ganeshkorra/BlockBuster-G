import {
    _decorator, Animation, AudioSource, BoxCollider, Color, Component, Material, MeshRenderer, Node,
    ParticleSystem, Tween, tween, Vec3,
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
    private particleBurstId = 0;
    private audio: AudioSource | null = null;
    private mesh: Node | null = null;
    private arrow: Node | null = null;
    private meshHomeScale = new Vec3(1, 1, 1);
    private arrowHomeScale = new Vec3(1, 1, 1);

    onLoad() {
        this.area = this.findChild('Area');
        this.particleNode = this.findChild('Particles');
        this.particles = this.particleNode?.getComponent(ParticleSystem) || this.getComponentInChildren(ParticleSystem) || null;
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
    playCrushFeedback(block: Block) {
        const sourceColour = this.blockColour(block) || new Color(255, 255, 255, 255);
        const particleColour = new Color(sourceColour.r, sourceColour.g, sourceColour.b, 255);
        this.setAnticipation(false, particleColour);
        this.playGateImpact();
        this.playAuthoredParticles(particleColour);
        this.audio?.play();
        GameFeelAudio.playCrushAndChips();
        this.getComponentInChildren(Animation)?.play();
    }

    private playGateImpact() {
        this.pulseNode(this.mesh, 1.045, 0.06, 0.15);
        this.pulseNode(this.arrow, 1.20, 0.06, 0.15);
    }

    /** Activates the existing child emitter without moving or reauthoring it. */
    private playAuthoredParticles(colour: Color | null) {
        const particles = this.particles;
        const particleNode = this.particleNode;
        if (!particles || !particleNode) return;

        particleNode.active = true;
        if (colour) particles.startColor.color = colour;
        particles.stop();
        particles.clear();
        particles.play();

        const burstId = ++this.particleBurstId;
        // Emit a compact authored burst, then allow its existing particles to
        // travel and fall. stopEmitting preserves already-spawned cube chips.
        this.scheduleOnce(() => {
            if (burstId !== this.particleBurstId || !particleNode.isValid) return;
            particles.stopEmitting();
        }, 0.28);
        this.scheduleOnce(() => {
            if (burstId !== this.particleBurstId || !particleNode.isValid) return;
            particles.stop();
            particles.clear();
            particleNode.active = false;
        }, 0.95);
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
