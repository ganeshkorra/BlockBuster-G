import {
    _decorator, Animation, AudioSource, BoxCollider, Color, Component, game, Game, Material, Mesh,
    MeshRenderer, Node, ParticleSystem, Tween, tween, utils, Vec3,
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
    private glowNode: Node | null = null;
    private glowMaterial: Material | null = null;
    private glowState = { alpha: 0 };
    private glowColour = new Color(255, 255, 255, 0);
    private static glowMesh: Mesh | null = null;

    onLoad() {
        this.area = this.findChild('Area');
        this.particleNode = this.findChild('Particles');
        this.particles = this.particleNode?.getComponent(ParticleSystem) || this.getComponentInChildren(ParticleSystem) || null;
        this.audio = this.getComponent(AudioSource);
        this.mesh = this.findChild('Mesh');
        this.arrow = this.findChild('Arrow');
        if (this.mesh) this.meshHomeScale.set(this.mesh.scale);
        if (this.arrow) this.arrowHomeScale.set(this.arrow.scale);
        game.on(Game.EVENT_HIDE, this.hideExitGlow, this);
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
        this.playExitGlow(particleColour);
        this.playAuthoredParticles(particleColour);
        this.audio?.play();
        GameFeelAudio.playCrushAndChips();
        this.getComponentInChildren(Animation)?.play();
    }

    private playGateImpact() {
        this.pulseNode(this.mesh, 1.045, 0.06, 0.15);
        this.pulseNode(this.arrow, 1.20, 0.06, 0.15);
    }

    /**
     * One reusable vertex-gradient beam per shredder. It begins at the outer
     * lip and widens along local +Z, matching the short trapezoid of bloom seen
     * when a block exits a gate. No geometry reaches into the board interior.
     */
    private playExitGlow(sourceColour: Color) {
        this.ensureExitGlow();
        const glowNode = this.glowNode;
        const material = this.glowMaterial;
        if (!glowNode || !material) return;

        const colour = this.readableGlowColour(sourceColour);
        this.glowColour.set(colour);
        this.glowState.alpha = 0;
        this.applyGlowAlpha();
        glowNode.active = true;

        Tween.stopAllByTarget(this.glowState);
        tween(this.glowState)
            .to(0.05, { alpha: this.glowPeakAlpha(sourceColour) }, {
                easing: 'quadOut',
                onUpdate: () => this.applyGlowAlpha(),
            })
            .delay(0.23)
            .to(0.32, { alpha: 0 }, {
                easing: 'sineIn',
                onUpdate: () => this.applyGlowAlpha(),
            })
            .call(() => {
                if (this.glowNode?.isValid) this.glowNode.active = false;
            })
            .start();
    }

    private ensureExitGlow() {
        if (this.glowNode?.isValid && this.glowMaterial) return;

        if (!Shredder.glowMesh) Shredder.glowMesh = this.createGradientGlowMesh();
        const glow = new Node('RuntimeShredderExitGlow');
        glow.layer = this.node.layer;
        this.node.addChild(glow);
        // Keep the spill just below the gate/chips in camera depth, but above
        // the board/background surfaces so it cannot be depth-occluded.
        // +Z is the authored outward direction for these top-edge shredders.
        glow.setPosition(0, -0.06, 0.34);
        const renderer = glow.addComponent(MeshRenderer);
        renderer.mesh = Shredder.glowMesh;

        const material = new Material();
        // builtin-unlit technique 2 is additive transparent and portable to the
        // WebGL runtime used by playable-ad preview environments.
        material.initialize({
            effectName: 'builtin-unlit',
            technique: 2,
            defines: { USE_VERTEX_COLOR: true },
        });
        renderer.setMaterial(material, 0);

        glow.active = false;
        this.glowNode = glow;
        this.glowMaterial = material;
    }

    private createGradientGlowMesh() {
        // The beam starts at the 5.1-unit shredder mouth and fans outward.
        // Its shape is deliberately a trapezoid rather than a rectangle: this
        // makes the bloom read as emitted by the exit, not laid on the board.
        const xFractions = [-1, -0.84, -0.54, 0, 0.54, 0.84, 1];
        const xAlpha = [0, 0.22, 0.72, 1, 0.72, 0.22, 0];
        // Keep the bloom close to the exit. Change this one value to tune its
        // visible distance without changing its source shape.
        const beamLength = 1.05;
        const zPositions = [0, 0.07, 0.18, 0.37, 0.58, 0.82, beamLength];
        const zAlpha = [0.88, 1, 0.92, 0.70, 0.42, 0.16, 0];
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];

        for (let zIndex = 0; zIndex < zPositions.length; zIndex++) {
            // The first row spans the gate opening; the far edge is wider and
            // fully transparent, leaving a naturally feathered fan shape.
            const halfWidth = 0.7 + (0.72 * zIndex / (zPositions.length - 1));
            for (let xIndex = 0; xIndex < xFractions.length; xIndex++) {
                positions.push(xFractions[xIndex] * halfWidth, 0, zPositions[zIndex]);
                normals.push(0, 1, 0);
                uvs.push(xIndex / (xFractions.length - 1), zIndex / (zPositions.length - 1));
                colors.push(1, 1, 1, xAlpha[xIndex] * zAlpha[zIndex]);
            }
        }
        for (let zIndex = 0; zIndex < zPositions.length - 1; zIndex++) {
            for (let xIndex = 0; xIndex < xFractions.length - 1; xIndex++) {
                const lowerLeft = zIndex * xFractions.length + xIndex;
                const lowerRight = lowerLeft + 1;
                const upperLeft = lowerLeft + xFractions.length;
                const upperRight = upperLeft + 1;
                indices.push(lowerLeft, upperLeft, lowerRight, lowerRight, upperLeft, upperRight);
            }
        }
        return utils.createMesh({
            positions,
            normals,
            uvs,
            colors,
            indices,
            minPos: new Vec3(-1.42, 0, 0),
            maxPos: new Vec3(1.42, 0, beamLength),
        });
    }

    private readableGlowColour(source: Color) {
        const brightness = (source.r + source.g + source.b) / 3;
        if (brightness < 48) return new Color(68, 86, 116, 255);
        if (brightness > 225) return new Color(218, 238, 255, 255);
        return new Color(
            Math.min(255, source.r * 1.10 + 10),
            Math.min(255, source.g * 1.10 + 10),
            Math.min(255, source.b * 1.10 + 10),
            255,
        );
    }

    private glowPeakAlpha(source: Color) {
        const brightness = (source.r + source.g + source.b) / 3;
        if (brightness < 48) return 112;
        if (brightness > 225) return 92;
        return 132;
    }

    private applyGlowAlpha() {
        if (!this.glowMaterial) return;
        this.glowMaterial.setProperty('mainColor', new Color(
            this.glowColour.r,
            this.glowColour.g,
            this.glowColour.b,
            Math.max(0, Math.min(255, this.glowState.alpha)),
        ));
    }

    private hideExitGlow() {
        Tween.stopAllByTarget(this.glowState);
        this.glowState.alpha = 0;
        this.applyGlowAlpha();
        if (this.glowNode?.isValid) this.glowNode.active = false;
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
        game.off(Game.EVENT_HIDE, this.hideExitGlow, this);
        this.hideExitGlow();
        this.glowMaterial?.destroy();
        this.glowMaterial = null;
        this.glowNode = null;
        GameFeelAudio.stopGateHum(this.node.uuid);
    }
}
