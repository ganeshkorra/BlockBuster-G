import { _decorator, Animation, AudioSource, BoxCollider, Color, Component, Material, MeshRenderer, Node, ParticleSystem, Quat, tween, Vec3 } from 'cc';
import { Block } from './Block';

const { ccclass } = _decorator;

/**
 * Behaviour owned by one goal/shredder. It exposes its authored Area trigger,
 * compares real mesh materials, and owns the existing particle/audio feedback.
 */
@ccclass('Shredder')
export class Shredder extends Component {
    private area: Node | null = null;
    private particles: ParticleSystem | null = null;
    private particleNode: Node | null = null;
    private audio: AudioSource | null = null;

    onLoad() {
        this.area = this.findChild('Area');
        this.particleNode = this.findChild('Particles');
        this.particles = this.particleNode?.getComponent(ParticleSystem) || this.getComponentInChildren(ParticleSystem) || null;
        this.audio = this.getComponent(AudioSource);
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

    /** The authored Area trigger is preferred; root colliders are a fallback. */
    dropColliders(): BoxCollider[] {
        const areaColliders = this.area?.getComponentsInChildren(BoxCollider) || [];
        if (areaColliders.length > 0) return areaColliders;
        return this.getComponentsInChildren(BoxCollider);
    }

    playCrushFeedback(block: Block, exitWorld: Readonly<Vec3>, launchDirection: Readonly<Vec3>, visibleSeconds: number) {
        this.getComponentInChildren(Animation)?.play();
        const particleNode = this.particleNode;
        const particles = this.particles;
        if (particles) {
            const homePosition = particleNode?.position.clone();
            const homeRotation = particleNode?.rotation.clone();
            if (particleNode) {
                particleNode.setWorldPosition(exitWorld);
                const direction = new Vec3(launchDirection.x, 0.10, launchDirection.z);
                Vec3.normalize(direction, direction);
                const rotation = new Quat();
                // The authored cone emits from local -Y.
                Quat.rotationTo(rotation, new Vec3(0, -1, 0), direction);
                particleNode.setWorldRotation(rotation);
                particleNode.active = true;
            }
            const colour = this.blockColour(block);
            if (colour) particles.startColor.color = colour;
            particles.loop = false;
            particles.duration = 0.24;
            particles.startLifetime.constant = 0.38;
            particles.startSpeed.constant = 3.2;
            particles.gravityModifier.constant = 0;
            particles.rateOverTime.constant = 48;
            particles.stop();
            particles.clear();
            particles.play();
            if (particleNode) {
                this.scheduleOnce(() => {
                    if (!particleNode.isValid) return;
                    particles.stop();
                    particles.clear();
                    particleNode.active = false;
                    if (homePosition) particleNode.setPosition(homePosition);
                    if (homeRotation) particleNode.setRotation(homeRotation);
                }, visibleSeconds);
            }
        }
        this.audio?.play();
        const homeScale = this.node.scale.clone();
        tween(this.node).to(0.08, { scale: homeScale.clone().multiplyScalar(1.08) }).to(0.18, { scale: homeScale }).start();
        const arrow = this.findChild('Arrow');
        if (arrow) {
            const arrowScale = arrow.scale.clone();
            tween(arrow).to(0.08, { scale: arrowScale.clone().multiplyScalar(1.18) }).to(0.16, { scale: arrowScale }).start();
        }
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
