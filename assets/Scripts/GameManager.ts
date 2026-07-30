import {
    _decorator, Animation, AudioSource, BoxCollider, Camera, Color, Component, EventTouch, find, geometry, Input, input,
    Material, MeshRenderer, Node, ParticleSystem, PhysicsSystem, primitives, Quat, resources, RigidBody, SphereLight, SpotLight,
    tween, Vec3,
    utils,
} from 'cc';
import { Block } from './Block';
import { Shredder } from './Shredder';

const { ccclass, property } = _decorator;

type Bounds3D = {
    minX: number; maxX: number;
    minY: number; maxY: number;
    minZ: number; maxZ: number;
};

/** One independently configured colour/type in a level. */
@ccclass('GameElement')
export class GameElement {
    @property({ tooltip: 'Unique stable ID, for example white or black.' })
    elementId = '';

    @property({ type: [Node], tooltip: 'Exact draggable block nodes. Array Size is the number of blocks.' })
    blockNodes: Node[] = [];

    @property({ type: [Node], tooltip: 'Exact matching shredder/goal nodes. Array Size is the number of target slots.' })
    targetShredders: Node[] = [];
}

/**
 * Scene-level drag-to-shredder interaction.
 *
 * Authoring convention:
 * - draggable block nodes are named Purple1, Purple2, …
 * - the matching destination is named Purple-Shredder
 * - their first shared material must be the same material asset.
 *
 * This intentionally uses the scene's prefabs, materials and colliders as-is;
 * no visual is recreated in code.
 */
@ccclass('GameManager')
export class GameManager extends Component {
    @property({ type: Camera, tooltip: 'Camera used to raycast the 3D purple blocks.' })
    camera: Camera | null = null;

    @property({ type: [GameElement], tooltip: 'Add one Element per block colour/type. Expand it to add its blocks and matching target shredders.' })
    elements: GameElement[] = [];

    private blocks: Node[] = [];
    private boardPhysical: Node | null = null;
    private grabbed: Node | null = null;
    private grabbedStartScale = new Vec3(1, 1, 1);
    private dragOffset = new Vec3();
    private isCrushing = false;
    private crushGlowMaterial: Material | null = null;
    private dragHeight = 0;
    private readonly particleVisibleSeconds = 0.65;

    start() {
        this.camera = this.camera || find('Main Camera')?.getComponent(Camera) || null;
        this.refreshSceneReferences();
        // this.preloadCrushGlow(); // Bloom/light VFX deliberately disabled.
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    }

    onDestroy() {
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    }

    /** Preloads the visible exit bloom so it is ready before the first crush. */
    private preloadCrushGlow() {
        resources.load('CrushVFX/CrushGlowMaterial', Material, (error, material) => {
            if (error) {
                console.warn('[GameManager] Crush glow material could not load.', error);
                return;
            }
            this.crushGlowMaterial = material;
        });
    }

    /** Rebuilds runtime lists solely from the Elements configured in the Inspector. */
    refreshSceneReferences() {
        this.boardPhysical = this.node.parent ? this.findDescendant(this.node.parent, 'BoardPhysical') : null;
        this.blocks = [];
        let configuredTargets = 0;
        for (const element of this.elements) {
            for (const target of element.targetShredders) {
                if (target && target.isValid) configuredTargets++;
            }
            for (const block of element.blockNodes) {
                if (!block || !block.isValid || this.blocks.indexOf(block) !== -1) continue;
                this.blocks.push(block);
            }
        }
        if (!this.boardPhysical || this.blocks.length === 0 || configuredTargets === 0) {
            console.warn(`[GameManager] Element setup incomplete. Elements: ${this.elements.length}; blocks: ${this.blocks.length}; target shredders: ${configuredTargets}; board walls: ${!!this.boardPhysical}`);
        } else {
            console.log(`[GameManager] Drag enabled for ${this.elements.length} configured element(s): ${this.blocks.map((block) => block.name).join(', ')}`);
        }
        // Puzzle blocks are positioned explicitly; disable gravity so physics never
        // causes them to fall through/over the decorative board while idle.
        for (const block of this.blocks) {
            const body = block.getComponent(RigidBody);
            if (body) body.useGravity = false;
        }
    }

    private findDescendant(root: Node, name: string): Node | null {
        if (root.name === name) return root;
        for (const child of root.children) {
            const result = this.findDescendant(child, name);
            if (result) return result;
        }
        return null;
    }

    private onTouchStart(event: EventTouch) {
        if (this.isCrushing || this.grabbed) return;
        const candidate = this.pickBlock(event);
        if (!candidate) return;

        const blockBehaviour = candidate.getComponent(Block);
        if (blockBehaviour && !blockBehaviour.beginDrag()) return;

        this.grabbed = candidate;
        this.grabbedStartScale.set(candidate.scale);
        this.dragHeight = candidate.worldPosition.y;
        const point = this.pointOnDragPlane(event);
        this.dragOffset.set(candidate.worldPosition).subtract(point);
        candidate.setScale(candidate.scale.clone().multiplyScalar(1.04));
    }

    private onTouchMove(event: EventTouch) {
        if (!this.grabbed) return;
        const dragged = this.grabbed;
        const target = this.pointOnDragPlane(event).add(this.dragOffset);
        target.y = this.dragHeight;
        this.keepInsideBoardColliders(dragged, target);
        // Do not allow a dragged footprint to enter another block footprint.
        // Keeping its last legal position is clearer and more controllable than
        // a physics push while the player is holding it.
        if (this.canPlaceWithoutOverlap(dragged, target)) {
            const blockBehaviour = dragged.getComponent(Block);
            if (blockBehaviour) blockBehaviour.moveTo(target);
            else dragged.setWorldPosition(target);
            // The Area trigger is the gameplay event. As soon as a matching
            // block enters it, crush at that exact dragged position—no snap.
            const shredder = this.matchingShredderDrop(dragged);
            if (shredder) {
                const block = dragged;
                this.grabbed = null;
                this.crush(block, shredder);
            }
        }
    }

    private onTouchEnd() {
        if (!this.grabbed) return;
        const block = this.grabbed;
        this.grabbed = null;
        const shredder = this.matchingShredderDrop(block);
        console.log(`[GameManager] ${block.name} drop: ${shredder ? 'matching configured shredder' : 'empty/incorrect space'}`);
        if (shredder) {
            this.crush(block, shredder);
            return;
        }
        // Empty board space is a valid destination. The block stays where it was
        // released; overlap and board-edge checks have already been enforced while dragging.
        const blockBehaviour = block.getComponent(Block);
        if (blockBehaviour) blockBehaviour.endDrag();
        else tween(block).to(0.08, { scale: this.grabbedStartScale }).start();
    }

    private onTouchCancel() {
        this.onTouchEnd();
    }

    private pickBlock(event: EventTouch): Node | null {
        if (!this.camera) return null;
        const ray = new geometry.Ray();
        this.camera.screenPointToRay(event.getLocationX(), event.getLocationY(), ray);
        if (PhysicsSystem.instance.raycastClosest(ray)) {
            let hit: Node | null = PhysicsSystem.instance.raycastClosestResult.collider.node;
            while (hit) {
                if (this.blocks.indexOf(hit) !== -1) return hit;
                hit = hit.parent;
            }
        }

        // Prefab instances can have their colliders disabled/removed by overrides.
        // Fall back to selecting the nearest block beneath the touch on the board plane.
        const touchPoint = this.pointOnDragPlane(event);
        let nearest: Node | null = null;
        let bestDistanceSq = 2.25 * 2.25;
        for (const block of this.blocks) {
            const blockWorldPosition = block.worldPosition;
            const dx = blockWorldPosition.x - touchPoint.x;
            const dz = blockWorldPosition.z - touchPoint.z;
            const distanceSq = dx * dx + dz * dz;
            if (distanceSq < bestDistanceSq) {
                nearest = block;
                bestDistanceSq = distanceSq;
            }
        }
        return nearest;
    }

    private pointOnDragPlane(event: EventTouch) {
        const ray = new geometry.Ray();
        this.camera!.screenPointToRay(event.getLocationX(), event.getLocationY(), ray);
        const directionY = ray.d.y;
        if (Math.abs(directionY) < 0.0001) return new Vec3();
        const t = (this.dragHeight - ray.o.y) / directionY;
        return new Vec3(ray.o.x + ray.d.x * t, this.dragHeight, ray.o.z + ray.d.z * t);
    }

    /** Returns a target only from the dragged block's own configured Element. */
    private matchingShredderDrop(block: Node): Node | null {
        let element: GameElement | null = null;
        for (const entry of this.elements) {
            if (entry.blockNodes.indexOf(block) !== -1) {
                element = entry;
                break;
            }
        }
        if (!element) return null;
        for (const shredder of element.targetShredders) {
            if (!shredder || !shredder.isValid) continue;
            // Element ownership is the main matching rule. The material check
            // detects a mistakenly assigned target in the Inspector.
            const blockBehaviour = block.getComponent(Block);
            const shredderBehaviour = shredder.getComponent(Shredder);
            const materialsMatch = blockBehaviour && shredderBehaviour
                ? shredderBehaviour.matches(blockBehaviour)
                : this.materialsMatch(block, shredder);
            if (materialsMatch && this.overlapsShredderTrigger(block, shredder)) return shredder;
        }
        return null;
    }

    /**
     * Uses the actual Shredder Area BoxCollider. If an Area is not configured,
     * the shredder's own BoxCollider is used as a practical fallback.
     */
    private overlapsShredderTrigger(block: Node, shredder: Node) {
        const blockColliders = this.allBoxColliders(block);
        const shredderBehaviour = shredder.getComponent(Shredder);
        const shredderColliders = shredderBehaviour?.dropColliders() || this.allBoxColliders(shredder);
        const triggers = shredderColliders.filter((collider) => collider.isTrigger);
        const targets = triggers.length > 0 ? triggers : shredderColliders;
        for (const blockCollider of blockColliders) {
            const blockBounds = this.worldBounds(blockCollider);
            for (const targetCollider of targets) {
                if (this.boundsIntersect(blockBounds, this.worldBounds(targetCollider))) return true;
            }
        }
        return false;
    }

    private allBoxColliders(root: Node) {
        const colliders: BoxCollider[] = [];
        const visit = (node: Node) => {
            const own = node.getComponents(BoxCollider);
            for (const collider of own) colliders.push(collider);
            for (const child of node.children) visit(child);
        };
        visit(root);
        return colliders;
    }

    private worldBounds(collider: BoxCollider) {
        const node = collider.node;
        const scale = node.worldScale;
        const position = node.worldPosition;
        const center = new Vec3(
            position.x + collider.center.x * scale.x,
            position.y + collider.center.y * scale.y,
            position.z + collider.center.z * scale.z,
        );
        const half = new Vec3(
            Math.abs(collider.size.x * scale.x) * 0.5,
            Math.abs(collider.size.y * scale.y) * 0.5,
            Math.abs(collider.size.z * scale.z) * 0.5,
        );
        return {
            minX: center.x - half.x, maxX: center.x + half.x,
            minY: center.y - half.y, maxY: center.y + half.y,
            minZ: center.z - half.z, maxZ: center.z + half.z,
        };
    }

    private boundsIntersect(a: Bounds3D, b: Bounds3D) {
        return a.minX < b.maxX && a.maxX > b.minX &&
            a.minY < b.maxY && a.maxY > b.minY &&
            a.minZ < b.maxZ && a.maxZ > b.minZ;
    }

    private canPlaceWithoutOverlap(dragged: Node, targetPosition: Readonly<Vec3>) {
        const draggedRects = this.colliderRects(dragged, targetPosition);
        for (const other of this.blocks) {
            if (other === dragged || !other.isValid) continue;
            const otherRects = this.colliderRects(other, other.worldPosition);
            for (const a of draggedRects) {
                for (const b of otherRects) {
                    if (this.rectanglesOverlap(a, b)) return false;
                }
            }
        }
        return true;
    }

    /**
     * Reads the four BoxColliders on BoardPhysical every drag. Horizontal thin
     * colliders are the top/bottom walls; vertical thin colliders are left/right.
     * This makes the board mesh/collider layout the single source of truth.
     */
    private keepInsideBoardColliders(dragged: Node, target: Vec3) {
        const bounds = this.readBoardInterior();
        if (!bounds) return;
        const rects = this.colliderRects(dragged, target);
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (const rect of rects) {
            minX = Math.min(minX, rect.minX);
            maxX = Math.max(maxX, rect.maxX);
            minZ = Math.min(minZ, rect.minZ);
            maxZ = Math.max(maxZ, rect.maxZ);
        }
        if (minX < bounds.minX) target.x += bounds.minX - minX;
        if (maxX > bounds.maxX) target.x -= maxX - bounds.maxX;
        if (minZ < bounds.minZ) target.z += bounds.minZ - minZ;
        if (maxZ > bounds.maxZ) target.z -= maxZ - bounds.maxZ;
    }

    private readBoardInterior() {
        if (!this.boardPhysical) return null;
        const walls = this.boardPhysical.getComponents(BoxCollider);
        let minX = Number.NEGATIVE_INFINITY;
        let maxX = Number.POSITIVE_INFINITY;
        let minZ = Number.NEGATIVE_INFINITY;
        let maxZ = Number.POSITIVE_INFINITY;
        let foundXWalls = false;
        let foundZWalls = false;
        const scale = this.boardPhysical.worldScale;
        const origin = this.boardPhysical.worldPosition;
        for (const wall of walls) {
            const centerX = origin.x + wall.center.x * scale.x;
            const centerZ = origin.z + wall.center.z * scale.z;
            const halfX = Math.abs(wall.size.x * scale.x) * 0.5;
            const halfZ = Math.abs(wall.size.z * scale.z) * 0.5;
            if (halfX < halfZ) {
                foundXWalls = true;
                if (centerX < origin.x) minX = Math.max(minX, centerX + halfX);
                else maxX = Math.min(maxX, centerX - halfX);
            } else {
                foundZWalls = true;
                if (centerZ < origin.z) minZ = Math.max(minZ, centerZ + halfZ);
                else maxZ = Math.min(maxZ, centerZ - halfZ);
            }
        }
        return foundXWalls && foundZWalls ? { minX, maxX, minZ, maxZ } : null;
    }

    /** Converts every BoxCollider on a block into a board-plane rectangle. */
    private colliderRects(node: Node, rootWorldPosition: Readonly<Vec3>) {
        const colliders = node.getComponents(BoxCollider);
        // A prefab without an explicit BoxCollider still receives a conservative
        // one-cell footprint, so it cannot ghost through the rest of the puzzle.
        if (colliders.length === 0) {
            return [{ minX: rootWorldPosition.x - 0.9, maxX: rootWorldPosition.x + 0.9, minZ: rootWorldPosition.z - 0.9, maxZ: rootWorldPosition.z + 0.9 }];
        }
        const rootDelta = new Vec3();
        Vec3.subtract(rootDelta, rootWorldPosition, node.worldPosition);
        return colliders.map((collider) => {
            const scale = collider.node.worldScale;
            const worldPosition = collider.node.worldPosition;
            const halfX = Math.abs(collider.size.x * scale.x) * 0.5 + 0.03;
            const halfZ = Math.abs(collider.size.z * scale.z) * 0.5 + 0.03;
            const centerX = worldPosition.x + collider.center.x * scale.x + rootDelta.x;
            const centerZ = worldPosition.z + collider.center.z * scale.z + rootDelta.z;
            return { minX: centerX - halfX, maxX: centerX + halfX, minZ: centerZ - halfZ, maxZ: centerZ + halfZ };
        });
    }

    private rectanglesOverlap(a: { minX: number, maxX: number, minZ: number, maxZ: number }, b: { minX: number, maxX: number, minZ: number, maxZ: number }) {
        return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
    }

    private materialsMatch(a: Node, b: Node) {
        const blockMaterials = this.sharedMaterials(a);
        const shredderMaterials = this.sharedMaterials(b);
        return blockMaterials.some((blockMaterial) => shredderMaterials.some((shredderMaterial) =>
            blockMaterial === shredderMaterial ||
            (!!blockMaterial.uuid && blockMaterial.uuid === shredderMaterial.uuid) ||
            (!!blockMaterial.name && blockMaterial.name === shredderMaterial.name),
        ));
    }

    /** A shredder may have separate Mesh and Arrow renderers; compare every material, not just the first one. */
    private sharedMaterials(root: Node): Material[] {
        const materials: Material[] = [];
        for (const renderer of root.getComponentsInChildren(MeshRenderer)) {
            for (let index = 0; index < renderer.sharedMaterials.length; index++) {
                const material = renderer.getSharedMaterial(index);
                if (material) materials.push(material);
            }
        }
        return materials;
    }

    private crush(block: Node, shredder: Node) {
        this.isCrushing = true;
        const impact = () => {
            // The visual impact begins on the exact frame the solid block
            // disappears, so fragments never appear before the crush.
            this.playShredderFeedback(shredder, block);
            this.blocks = this.blocks.filter((entry) => entry !== block);
            block.destroy();
            this.isCrushing = false;
        };
        const blockBehaviour = block.getComponent(Block);
        if (blockBehaviour) blockBehaviour.consume(0.05, impact);
        else tween(block).delay(0.05).call(impact).start();
    }

    private playShredderFeedback(shredder: Node, block: Node) {
        const blockBehaviour = block.getComponent(Block);
        const shredderBehaviour = shredder.getComponent(Shredder);
        if (blockBehaviour && shredderBehaviour) {
            const launchDirection = this.shredderExitNormal(block, shredder);
            shredderBehaviour.playCrushFeedback(
                blockBehaviour,
                this.shredderExitWorld(block, shredder),
                launchDirection,
                this.particleVisibleSeconds,
            );
            return;
        }
        shredder.getComponentInChildren(Animation)?.play();
        const particleNode = this.findDescendant(shredder, 'Particles');
        const particles = particleNode?.getComponent(ParticleSystem) || shredder.getComponentInChildren(ParticleSystem);
        if (particles) {
            // The emitter is intentionally off while idle. Enabling it only for
            // the impact keeps the board clean and gives the burst its punch.
            const particleHome = particleNode?.position.clone();
            const particleHomeRotation = particleNode?.rotation.clone();
            if (particleNode) {
                // Emit at the outer gate lip, matching the visible fragments
                // and the floor-light focus in the reference.
                particleNode.setWorldPosition(this.shredderExitWorld(block, shredder));
                const launchDirection = this.shredderExitNormal(block, shredder);
                launchDirection.y = 0.10;
                Vec3.normalize(launchDirection, launchDirection);
                const particleRotation = new Quat();
                // This prefab's cone emits on its local -Y axis (the authored
                // 180° X rotation makes the idle preview rise upward). Map
                // that real emission axis to the gate exit direction.
                Quat.rotationTo(particleRotation, new Vec3(0, -1, 0), launchDirection);
                particleNode.setWorldRotation(particleRotation);
                particleNode.active = true;
            }
            const colour = this.blockMainColour(block);
            if (colour) particles.startColor.color = colour;
            this.configureReferenceBurst(particles);
            particles.stop();
            particles.clear();
            particles.play();
            if (particleNode) {
                this.scheduleOnce(() => {
                    if (!particleNode.isValid) return;
                    particles.stop();
                    particles.clear();
                    particleNode.active = false;
                    if (particleHome) particleNode.setPosition(particleHome);
                    if (particleHomeRotation) particleNode.setRotation(particleHomeRotation);
                }, this.particleVisibleSeconds);
            }
        } else {
            console.warn('[GameManager] Purple-Shredder has no ParticleSystem on its Particles node.');
        }
        // this.playCrushBloom(block, shredder); // Bloom/light VFX deliberately disabled.
        shredder.getComponent(AudioSource)?.play();
        const home = shredder.scale.clone();
        tween(shredder)
            .to(0.08, { scale: home.clone().multiplyScalar(1.08) })
            .to(0.18, { scale: home })
            .start();
        const arrow = this.findDescendant(shredder, 'Arrow');
        if (arrow) {
            const arrowHome = arrow.scale.clone();
            tween(arrow).to(0.08, { scale: arrowHome.clone().multiplyScalar(1.18) }).to(0.16, { scale: arrowHome }).start();
        }
    }

    /** A soft same-colour pool of light under the exit particles. */
    private playCrushLightFocus(shredder: Node, block: Node) {
        let focusNode = this.findDescendant(shredder, 'CrushLightFocus');
        if (!focusNode) {
            focusNode = new Node('CrushLightFocus');
            focusNode.parent = shredder;
        }
        // Older previews may have the previous spherical focus. Disable it so
        // there is a single soft floor-focused highlight rather than two lights.
        const spherical = focusNode.getComponent(SphereLight);
        if (spherical) spherical.enabled = false;
        let focus = focusNode.getComponent(SpotLight);
        if (!focus) focus = focusNode.addComponent(SpotLight);
        const impact = this.shredderExitWorld(block, shredder);
        focusNode.setWorldPosition(new Vec3(impact.x, impact.y + 3.2, impact.z));
        // A vertical look direction needs a horizontal up vector; using world
        // Y as both direction/up makes the spotlight orientation degenerate.
        focusNode.lookAt(impact, new Vec3(0, 0, 1));
        focus.color = this.blockMainColour(block) || new Color(255, 255, 255, 255);
        focus.range = 5.6;
        focus.spotAngle = 70;
        focus.shadowEnabled = false;
        focus.luminance = 0;
        focusNode.active = true;
        tween(focus)
            // Main Light is 65k in this scene, so this must peak above it to
            // read as a visible circular focus on the dark board.
            .to(0.06, { luminance: 85000 }, { easing: 'quadOut' })
            .to(0.34, { luminance: 0 }, { easing: 'quadIn' })
            .call(() => { if (focusNode && focusNode.isValid) focusNode.active = false; })
            .start();
    }

    /**
     * A rendered, transparent floor bloom. This remains visible even when the
     * board material does not receive dynamic lights, unlike the spotlight.
     */
    private playCrushBloom(block: Node, shredder: Node) {
        if (!this.crushGlowMaterial) return;
        const bloom = new Node('CrushBloom');
        (this.node.parent || shredder.parent)?.addChild(bloom);
        const impact = this.shredderExitWorld(block, shredder);
        bloom.setWorldPosition(new Vec3(impact.x, impact.y + 0.018, impact.z));
        const renderer = bloom.addComponent(MeshRenderer);
        renderer.mesh = utils.createMesh(primitives.plane({
            length: 1,
            width: 1,
            lengthSegments: 1,
            widthSegments: 1,
        }));
        // This material belongs only to the transient bloom; sharing it avoids
        // mutating any block or board material and is safe between crushes.
        const material = this.crushGlowMaterial;
        const blockColour = this.blockMainColour(block);
        // Preserve readable brightness for dark pieces while keeping the bloom
        // recognisably tied to the crushed block's colour.
        const tint = blockColour
            ? new Color(Math.max(130, blockColour.r), Math.max(130, blockColour.g), Math.max(130, blockColour.b), 112)
            : new Color(255, 255, 255, 112);
        material.setProperty('mainColor', tint);
        renderer.setMaterial(material, 0);

        // Match the authored gate footprint instead of covering a large part
        // of the board. The small outward extension sits behind the particles.
        const fullSize = this.shredderBloomSize(shredder);
        bloom.setScale(fullSize.x * 0.78, 1, fullSize.z * 0.78);
        tween(bloom)
            .to(0.06, { scale: fullSize }, { easing: 'quadOut' })
            .to(0.28, { scale: new Vec3(fullSize.x * 1.12, 1, fullSize.z * 1.12) }, { easing: 'sineOut' })
            .call(() => { if (bloom.isValid) bloom.destroy(); })
            .start();
    }

    /** Size the bloom from the real gate collider, with only a shallow exit lip. */
    private shredderBloomSize(shredder: Node) {
        const collider = this.shredderRootCollider(shredder);
        if (!collider) return new Vec3(2, 1, 1.2);
        const bounds = this.worldBounds(collider);
        const spanX = bounds.maxX - bounds.minX;
        const spanZ = bounds.maxZ - bounds.minZ;
        if (spanX >= spanZ) return new Vec3(spanX * 1.04, 1, Math.max(1.15, spanZ * 1.65));
        return new Vec3(Math.max(1.15, spanX * 1.65), 1, spanZ * 1.04);
    }

    /** Area validates the drop; visible movement keeps the current exit lane. */
    private shredderExitInBlockParent(block: Node, shredder: Node) {
        const centerWorld = this.shredderExitWorld(block, shredder);
        const parent = block.parent;
        if (!parent) return centerWorld;
        const localTarget = new Vec3();
        parent.inverseTransformPoint(localTarget, centerWorld);
        return localTarget;
    }

    private shredderRootCollider(shredder: Node) {
        const all = this.allBoxColliders(shredder);
        let rootCollider: BoxCollider | undefined;
        for (let index = 0; index < all.length; index++) {
            if (all[index].node === shredder && !all[index].isTrigger) {
                rootCollider = all[index];
                break;
            }
        }
        return rootCollider;
    }

    /** Outward board-plane direction, inferred from the real gate collider. */
    private shredderExitNormal(block: Node, shredder: Node) {
        const collider = this.shredderRootCollider(shredder);
        if (!collider) return new Vec3(0, 0, 1);
        const bounds = this.worldBounds(collider);
        const boardCenter = this.boardPhysical ? this.boardPhysical.worldPosition : Vec3.ZERO;
        const spanX = bounds.maxX - bounds.minX;
        const spanZ = bounds.maxZ - bounds.minZ;
        if (spanX >= spanZ) return new Vec3(0, 0, block.worldPosition.z >= boardCenter.z ? 1 : -1);
        return new Vec3(block.worldPosition.x >= boardCenter.x ? 1 : -1, 0, 0);
    }

    /** Carries the block fully beyond the outer edge, without sideways recentering. */
    private shredderExitWorld(block: Node, shredder: Node) {
        const collider = this.shredderRootCollider(shredder);
        if (!collider) return shredder.worldPosition.clone();
        const bounds = this.worldBounds(collider);
        const exit = block.worldPosition.clone();
        const spanX = bounds.maxX - bounds.minX;
        const spanZ = bounds.maxZ - bounds.minZ;
        const boardCenter = this.boardPhysical ? this.boardPhysical.worldPosition : Vec3.ZERO;
        if (spanX >= spanZ) {
            const sign = exit.z >= boardCenter.z ? 1 : -1;
            exit.z = (bounds.minZ + bounds.maxZ) * 0.5 + sign * (spanZ * 0.5 + this.blockHalfExtent(block, 'z'));
        } else {
            const sign = exit.x >= boardCenter.x ? 1 : -1;
            exit.x = (bounds.minX + bounds.maxX) * 0.5 + sign * (spanX * 0.5 + this.blockHalfExtent(block, 'x'));
        }
        return exit;
    }

    private blockHalfExtent(block: Node, axis: 'x' | 'z') {
        const colliders = this.allBoxColliders(block);
        if (colliders.length === 0) return 0.5;
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (const collider of colliders) {
            const bounds = this.worldBounds(collider);
            min = Math.min(min, axis === 'x' ? bounds.minX : bounds.minZ);
            max = Math.max(max, axis === 'x' ? bounds.maxX : bounds.maxZ);
        }
        return Math.max(0.1, (max - min) * 0.5);
    }

    /** Reads mainColor from the selected block material and applies it to the particle burst. */
    private blockMainColour(block: Node): Color | null {
        const materials = this.sharedMaterials(block);
        for (const material of materials) {
            const value = material.getProperty('mainColor') as Color | null;
            if (value && typeof value.r === 'number') return new Color(value.r, value.g, value.b, value.a);
        }
        return null;
    }

    /** A compact exit burst; avoids the long fountain seen in the previous recording. */
    private configureReferenceBurst(particles: ParticleSystem) {
        particles.loop = false;
        particles.duration = 0.24;
        particles.startLifetime.constant = 0.38;
        particles.startSpeed.constant = 3.2;
        particles.gravityModifier.constant = 0;
        particles.rateOverTime.constant = 48;
    }

}
