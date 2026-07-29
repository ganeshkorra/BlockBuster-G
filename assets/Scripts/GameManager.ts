import {
    _decorator, Animation, AudioSource, BoxCollider, Camera, Color, Component, EventTouch, find, geometry, Input, input,
    Material, MeshRenderer, Node, ParticleSystem, PhysicsSystem, RigidBody,
    tween, Vec3,
} from 'cc';

const { ccclass, property } = _decorator;

type Bounds3D = {
    minX: number; maxX: number;
    minY: number; maxY: number;
    minZ: number; maxZ: number;
};

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

    @property({ tooltip: 'Names beginning with this text are draggable, except the Shredder node.' })
    blockPrefix = 'Purple';

    @property({ tooltip: 'Exact scene node name of the destination shredder.' })
    shredderName = 'Purple-Shredder';

    @property({ tooltip: 'Name of the board child that owns the four wall BoxColliders.' })
    boardPhysicalName = 'BoardPhysical';

    @property({ tooltip: 'The height used while dragging. Set it just above the board surface.' })
    dragPlaneY = 0.55;

    @property({ tooltip: 'How long the Shredder particle node remains active after a crush.' })
    particleVisibleSeconds = 0.65;

    private blocks: Node[] = [];
    private shredder: Node | null = null;
    private boardPhysical: Node | null = null;
    private grabbed: Node | null = null;
    private grabbedStartScale = new Vec3(1, 1, 1);
    private dragOffset = new Vec3();
    private isCrushing = false;

    start() {
        this.camera = this.camera || find('Main Camera')?.getComponent(Camera) || null;
        this.refreshSceneReferences();
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

    /** Call after duplicating/renaming blocks in the editor at runtime. */
    refreshSceneReferences() {
        this.shredder = this.findDescendant(this.node, this.shredderName);
        this.boardPhysical = this.node.parent ? this.findDescendant(this.node.parent, this.boardPhysicalName) : null;
        this.blocks = [];
        this.collectBlocks(this.node);
        if (!this.shredder || !this.boardPhysical || this.blocks.length === 0) {
            console.warn(`[GameManager] Drag setup incomplete. Blocks: ${this.blocks.length}; shredder: ${!!this.shredder}; board walls: ${!!this.boardPhysical}`);
        } else {
            console.log(`[GameManager] Drag enabled for: ${this.blocks.map((block) => block.name).join(', ')}`);
        }
        // Puzzle blocks are positioned explicitly; disable gravity so physics never
        // causes them to fall through/over the decorative board while idle.
        for (const block of this.blocks) {
            const body = block.getComponent(RigidBody);
            if (body) body.useGravity = false;
        }
    }

    private collectBlocks(root: Node) {
        for (const child of root.children) {
            if (child !== this.shredder && child.name.startsWith(this.blockPrefix) && child.getComponent(RigidBody)) {
                this.blocks.push(child);
            }
            this.collectBlocks(child);
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

        this.grabbed = candidate;
        this.grabbedStartScale.set(candidate.scale);
        const point = this.pointOnDragPlane(event);
        this.dragOffset.set(candidate.position).subtract(point);
        candidate.setScale(candidate.scale.clone().multiplyScalar(1.04));
    }

    private onTouchMove(event: EventTouch) {
        if (!this.grabbed) return;
        const dragged = this.grabbed;
        const target = this.pointOnDragPlane(event).add(this.dragOffset);
        target.y = this.dragPlaneY;
        this.keepInsideBoardColliders(dragged, target);
        // Do not allow a dragged footprint to enter another block footprint.
        // Keeping its last legal position is clearer and more controllable than
        // a physics push while the player is holding it.
        if (this.canPlaceWithoutOverlap(dragged, target)) {
            dragged.setPosition(target);
            // The Area trigger is the gameplay event. As soon as a matching
            // block enters it, crush at that exact dragged position—no snap.
            if (this.isValidShredderDrop(dragged)) {
                const block = dragged;
                this.grabbed = null;
                this.crush(block);
            }
        }
    }

    private onTouchEnd() {
        if (!this.grabbed) return;
        const block = this.grabbed;
        this.grabbed = null;
        const validShredderDrop = this.isValidShredderDrop(block);
        console.log(`[GameManager] ${block.name} drop: ${validShredderDrop ? 'matching shredder' : 'empty/incorrect space'}`);
        if (validShredderDrop) {
            this.crush(block);
            return;
        }
        // Empty board space is a valid destination. The block stays where it was
        // released; overlap and board-edge checks have already been enforced while dragging.
        tween(block).to(0.08, { scale: this.grabbedStartScale }).start();
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
            const dx = block.position.x - touchPoint.x;
            const dz = block.position.z - touchPoint.z;
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
        const t = (this.dragPlaneY - ray.o.y) / directionY;
        return new Vec3(ray.o.x + ray.d.x * t, this.dragPlaneY, ray.o.z + ray.d.z * t);
    }

    private isValidShredderDrop(block: Node) {
        return !!this.shredder &&
            this.materialsMatch(block, this.shredder) &&
            this.overlapsShredderTrigger(block, this.shredder);
    }

    /**
     * Uses the actual Shredder Area BoxCollider. If an Area is not configured,
     * the shredder's own BoxCollider is used as a practical fallback.
     */
    private overlapsShredderTrigger(block: Node, shredder: Node) {
        const blockColliders = this.allBoxColliders(block);
        const shredderColliders = this.allBoxColliders(shredder);
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
            const otherRects = this.colliderRects(other, other.position);
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
    private colliderRects(node: Node, rootPosition: Readonly<Vec3>) {
        const scale = node.scale;
        const colliders = node.getComponents(BoxCollider);
        // A prefab without an explicit BoxCollider still receives a conservative
        // one-cell footprint, so it cannot ghost through the rest of the puzzle.
        if (colliders.length === 0) {
            return [{ minX: rootPosition.x - 0.9, maxX: rootPosition.x + 0.9, minZ: rootPosition.z - 0.9, maxZ: rootPosition.z + 0.9 }];
        }
        return colliders.map((collider) => {
            const halfX = Math.abs(collider.size.x * scale.x) * 0.5 + 0.03;
            const halfZ = Math.abs(collider.size.z * scale.z) * 0.5 + 0.03;
            const centerX = rootPosition.x + collider.center.x * scale.x;
            const centerZ = rootPosition.z + collider.center.z * scale.z;
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

    private crush(block: Node) {
        this.isCrushing = true;
        const shredder = this.shredder!;
        tween(block)
            .call(() => this.playShredderFeedback(shredder, block))
            .delay(0.05)
            .call(() => {
                this.blocks = this.blocks.filter((entry) => entry !== block);
                block.destroy();
                this.isCrushing = false;
            })
            .start();
    }

    private playShredderFeedback(shredder: Node, block: Node) {
        shredder.getComponentInChildren(Animation)?.play();
        const particleNode = this.findDescendant(shredder, 'Particles');
        const particles = particleNode?.getComponent(ParticleSystem) || shredder.getComponentInChildren(ParticleSystem);
        if (particles) {
            // The emitter is intentionally off while idle. Enabling it only for
            // the impact keeps the board clean and gives the burst its punch.
            const particleHome = particleNode?.position.clone();
            if (particleNode) {
                // Emit at the exact physical trigger contact point.
                particleNode.setWorldPosition(block.worldPosition);
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
                }, this.particleVisibleSeconds);
            }
        } else {
            console.warn('[GameManager] Purple-Shredder has no ParticleSystem on its Particles node.');
        }
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
