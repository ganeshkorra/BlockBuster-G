import {
    _decorator, BoxCollider, Camera, Color, Component, EventTouch, find, geometry, Input, input,
    Material, MeshRenderer, Node, PhysicsSystem, RigidBody, Tween, tween, Vec3,
} from 'cc';
import { Block } from './Block';
import { Shredder } from './Shredder';

const { ccclass, property } = _decorator;

type Bounds3D = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

/** One independently configurable colour/type. Its node arrays are the level authoring interface. */
@ccclass('GameElement')
export class GameElement {
    @property({ tooltip: 'Unique stable ID, e.g. White or Black.' })
    elementId = '';

    @property({ type: [Node], tooltip: 'Exact draggable blocks for this element.' })
    blockNodes: Node[] = [];

    @property({ type: [Node], tooltip: 'Matching shredder goal slots for this element.' })
    targetShredders: Node[] = [];
}

/** Input, board legality, gate routing, and global game-feel feedback. */
@ccclass('GameManager')
export class GameManager extends Component {
    @property({ type: Camera, tooltip: 'The board camera.' })
    camera: Camera | null = null;

    @property({ type: [GameElement], tooltip: 'Add one Element for each block colour/type in a level.' })
    elements: GameElement[] = [];

    private blocks: Node[] = [];
    private boardPhysical: Node | null = null;
    private grabbed: Node | null = null;
    private anticipated: Shredder | null = null;
    private isCrushing = false;
    private dragHeight = 0;
    /** Offset from the finger to the grabbed point on the block. */
    private dragOffset = new Vec3();

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

    /** Rebuilds runtime state exclusively from the Elements inspector arrays. */
    refreshSceneReferences() {
        // Search from the actual scene root. This keeps the BoardPhysical
        // collider lookup valid even when GameManager is nested differently in
        // another level scene.
        let sceneRoot: Node = this.node;
        while (sceneRoot.parent) sceneRoot = sceneRoot.parent;
        this.boardPhysical = this.findDescendant(sceneRoot, 'BoardPhysical');
        this.blocks = [];
        for (const element of this.elements) {
            for (const block of element.blockNodes) {
                if (block && block.isValid && this.blocks.indexOf(block) === -1) this.blocks.push(block);
            }
        }
        for (const block of this.blocks) {
            const body = block.getComponent(RigidBody);
            if (body) body.useGravity = false;
        }
        if (!this.boardPhysical || this.blocks.length === 0) console.warn('[GameManager] Add BoardPhysical and Element block references.');
    }

    /**
     * Block follows are smoothed in Block.update(), after touch input has been
     * processed. Clamp the final world position too: this closes the one-frame
     * escape that can happen on a very fast drag. The four authored
     * BoardPhysical BoxColliders remain the only boundary data used here.
     */
    lateUpdate() {
        if (!this.grabbed || this.isCrushing) return;
        const constrained = this.grabbed.worldPosition.clone();
        this.keepInsideBoardColliders(this.grabbed, constrained);
        if (constrained.x !== this.grabbed.worldPosition.x || constrained.z !== this.grabbed.worldPosition.z) {
            this.grabbed.setWorldPosition(constrained);
        }
    }

    private onTouchStart(event: EventTouch) {
        if (this.isCrushing || this.grabbed) return;
        const block = this.pickBlock(event);
        const behaviour = block?.getComponent(Block) || null;
        if (!block || !behaviour || !behaviour.beginDrag()) return;
        this.grabbed = block;
        this.dragHeight = block.worldPosition.y;
        const touchPoint = this.pointOnDragPlane(event);
        Vec3.subtract(this.dragOffset, block.worldPosition, touchPoint);
        this.dragOffset.y = 0;
    }

    private onTouchMove(event: EventTouch) {
        const block = this.grabbed;
        if (!block) return;
        const target = this.pointOnDragPlane(event);
        target.x += this.dragOffset.x;
        target.z += this.dragOffset.z;
        this.keepInsideBoardColliders(block, target);
        const resolved = this.resolveDragTarget(block, target);
        block.getComponent(Block)?.moveTo(resolved);
        this.updateGateAnticipation(block);
    }

    private onTouchEnd() {
        const block = this.grabbed;
        if (!block) return;
        this.grabbed = null;
        // Complete the short follow smoothing before evaluating the drop.
        // This keeps a quick release over a gate from feeling unresponsive.
        block.getComponent(Block)?.settleDrag();
        const shredder = this.matchingShredderDrop(block);
        if (shredder) this.crush(block, shredder);
        else {
            this.snapBlockToGrid(block);
            this.clearGateAnticipation();
            block.getComponent(Block)?.endDrag();
        }
    }

    private onTouchCancel() { this.onTouchEnd(); }

    private crush(block: Node, shredderNode: Node) {
        if (this.isCrushing || !block.isValid) return;
        const blockBehaviour = block.getComponent(Block);
        const shredder = shredderNode.getComponent(Shredder);
        if (!blockBehaviour || !shredder) return;

        this.isCrushing = true;
        if (this.anticipated === shredder) {
            // Keep the matching gate energized throughout the intake. The
            // crush feedback turns it off exactly when the block reaches the rim.
            this.anticipated = null;
        } else {
            this.clearGateAnticipation();
            shredder.setAnticipation(true, this.blockMainColour(block));
        }
        const direction = this.shredderExitNormal(block, shredderNode);
        const exit = this.shredderExitWorld(block, shredderNode, direction);

        // The block stays intact while it travels outward. The exit calculation
        // retains its lateral coordinate, eliminating the old centre/left snap.
        blockBehaviour.consumeThrough(exit, 0.50, () => {
            // Begin the authored crush feedback after 20% of the block has
            // entered the shredder, while the remaining intake continues.
            shredder.playCrushFeedback(blockBehaviour);
            this.playCameraImpact(direction);
        }, () => {
            // The child particle system is inactive before the crush, so its first
            // visible chips arrive on the following render frame. The block is
            // removed only after it completes the remaining 80% of its intake.
            this.scheduleOnce(() => {
                if (block.isValid) {
                    this.blocks = this.blocks.filter((entry) => entry !== block);
                    block.destroy();
                }
                this.isCrushing = false;
            }, 0.04);
        });
    }

    /** Highlights only a matching gate that is close to the held piece. */
    private updateGateAnticipation(block: Node) {
        let nearest: Shredder | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const gateNode of this.targetsFor(block)) {
            const gate = gateNode.getComponent(Shredder);
            if (!gate) continue;
            const distance = this.distanceToDropArea(block, gateNode);
            if (distance < 1.35 && distance < nearestDistance) {
                nearest = gate;
                nearestDistance = distance;
            }
        }
        if (nearest === this.anticipated) return;
        this.clearGateAnticipation();
        if (nearest) {
            nearest.setAnticipation(true, this.blockMainColour(block));
            this.anticipated = nearest;
        }
    }

    private clearGateAnticipation() {
        if (!this.anticipated) return;
        this.anticipated.setAnticipation(false, null);
        this.anticipated = null;
    }

    private distanceToDropArea(block: Node, shredder: Node) {
        const point = block.worldPosition;
        let best = Number.POSITIVE_INFINITY;
        const gate = shredder.getComponent(Shredder);
        for (const collider of gate?.dropColliders() || this.allBoxColliders(shredder)) {
            const bounds = this.worldBounds(collider);
            const dx = Math.max(bounds.minX - point.x, 0, point.x - bounds.maxX);
            const dz = Math.max(bounds.minZ - point.z, 0, point.z - bounds.maxZ);
            best = Math.min(best, Math.sqrt(dx * dx + dz * dz));
        }
        return best;
    }

    private matchingShredderDrop(block: Node): Node | null {
        for (const target of this.targetsFor(block)) {
            const shredder = target.getComponent(Shredder);
            // The Elements inspector explicitly assigns every block colour to
            // its legal shredder. Do not make that authored link depend on a
            // second material comparison: prefab material overrides can make
            // two visibly identical Pink materials appear as different runtime
            // objects and incorrectly reject an otherwise valid drop.
            if (shredder && this.overlapsShredderTrigger(block, target)) return target;
        }
        return null;
    }

    private targetsFor(block: Node): Node[] {
        for (const element of this.elements) {
            if (element.blockNodes.indexOf(block) !== -1) return element.targetShredders.filter((node) => !!node && node.isValid);
        }
        return [];
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
        // Controlled fallback for a prefab collider disabled by an override.
        const point = this.pointOnDragPlane(event);
        let candidate: Node | null = null;
        let best = 2.25 * 2.25;
        for (const block of this.blocks) {
            const position = block.worldPosition;
            const dx = position.x - point.x;
            const dz = position.z - point.z;
            const distance = dx * dx + dz * dz;
            if (distance < best) { best = distance; candidate = block; }
        }
        return candidate;
    }

    private pointOnDragPlane(event: EventTouch) {
        const ray = new geometry.Ray();
        this.camera!.screenPointToRay(event.getLocationX(), event.getLocationY(), ray);
        if (Math.abs(ray.d.y) < 0.0001) return new Vec3();
        const t = (this.dragHeight - ray.o.y) / ray.d.y;
        return new Vec3(ray.o.x + ray.d.x * t, this.dragHeight, ray.o.z + ray.d.z * t);
    }

    private overlapsShredderTrigger(block: Node, shredder: Node) {
        const gate = shredder.getComponent(Shredder);
        const targets = gate?.dropColliders() || this.allBoxColliders(shredder);
        for (const blockCollider of this.allBoxColliders(block)) {
            for (const targetCollider of targets) {
                const trigger = this.worldBounds(targetCollider);
                // The authored Area collider is intentionally a very thin slit.
                // Give a released block a forgiving intake margin so a block
                // stopped by the board wall can still enter its assigned gate.
                // A full block can be held back from the physical rim by its
                // own collider. Let the gate reach one block inward, matching
                // the visible mouth rather than requiring a pixel-perfect
                // overlap with its tiny authored trigger.
                const intakeMargin = 0.15;
                trigger.minX -= intakeMargin;
                trigger.maxX += intakeMargin;
                trigger.minZ -= intakeMargin;
                trigger.maxZ += intakeMargin;
                if (this.boundsIntersect(this.worldBounds(blockCollider), trigger)) return true;
            }
        }
        return false;
    }

    /**
     * The four BoxColliders authored on BoardPhysical are the only source of
     * truth for the board boundary. Their inner faces define the legal area;
     * no board dimensions or wall offsets are duplicated in code.
     */
    private keepInsideBoardColliders(block: Node, target: Vec3) {
        const board = this.readBoardInterior();
        if (!board) return;
        const rects = this.colliderRects(block, target);
        const minX = Math.min(...rects.map((rect) => rect.minX));
        const maxX = Math.max(...rects.map((rect) => rect.maxX));
        const minZ = Math.min(...rects.map((rect) => rect.minZ));
        const maxZ = Math.max(...rects.map((rect) => rect.maxZ));
        if (minX < board.minX) target.x += board.minX - minX;
        if (maxX > board.maxX) target.x -= maxX - board.maxX;
        if (minZ < board.minZ) target.z += board.minZ - minZ;
        if (maxZ > board.maxZ) target.z -= maxZ - board.maxZ;
    }

    private canPlaceWithoutOverlap(dragged: Node, target: Readonly<Vec3>) {
        const draggingRects = this.colliderRects(dragged, target);
        for (const other of this.blocks) {
            if (other === dragged || !other.isValid) continue;
            for (const current of draggingRects) {
                for (const occupied of this.colliderRects(other, other.worldPosition)) {
                    if (this.rectanglesOverlap(current, occupied)) return false;
                }
            }
        }
        return true;
    }

    /**
     * Keeps direct finger tracking when space is clear, then slides along the
     * free axis at an obstacle. A short sweep finds the nearest legal contact
     * point when both axes are blocked, avoiding the old sticky/frozen drag.
     */
    private resolveDragTarget(dragged: Node, desired: Readonly<Vec3>) {
        const target = new Vec3(desired.x, desired.y, desired.z);
        if (this.canPlaceWithoutOverlap(dragged, target)) return target;

        const current = dragged.worldPosition.clone();
        const xOnly = new Vec3(target.x, target.y, current.z);
        const zOnly = new Vec3(current.x, target.y, target.z);
        this.keepInsideBoardColliders(dragged, xOnly);
        this.keepInsideBoardColliders(dragged, zOnly);

        const legal: Vec3[] = [];
        if (this.canPlaceWithoutOverlap(dragged, xOnly)) legal.push(xOnly);
        if (this.canPlaceWithoutOverlap(dragged, zOnly)) legal.push(zOnly);
        if (legal.length > 0) {
            let closest = legal[0];
            let closestDistance = this.planarDistanceSquared(closest, target);
            for (let index = 1; index < legal.length; index++) {
                const distance = this.planarDistanceSquared(legal[index], target);
                if (distance < closestDistance) {
                    closest = legal[index];
                    closestDistance = distance;
                }
            }
            return closest;
        }

        let low = 0;
        let high = 1;
        let lastLegal = current;
        for (let step = 0; step < 7; step++) {
            const amount = (low + high) * 0.5;
            const candidate = new Vec3();
            Vec3.lerp(candidate, current, target, amount);
            this.keepInsideBoardColliders(dragged, candidate);
            if (this.canPlaceWithoutOverlap(dragged, candidate)) {
                low = amount;
                lastLegal = candidate;
            } else {
                high = amount;
            }
        }
        return lastLegal;
    }

    private planarDistanceSquared(a: Readonly<Vec3>, b: Readonly<Vec3>) {
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        return dx * dx + dz * dz;
    }

    /**
     * Drops pieces onto the nearest unoccupied grid position. The board's
     * centre defines the grid origin, so authored BoardPhysical colliders stay
     * the only board configuration required by this scene.
     */
    private snapBlockToGrid(block: Node) {
        const current = block.worldPosition;
        const origin = this.boardPhysical?.worldPosition || Vec3.ZERO;
        const baseX = Math.round(current.x - origin.x) + origin.x;
        const baseZ = Math.round(current.z - origin.z) + origin.z;
        let best: Vec3 | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        // Try the closest cell first, then a small ring around it when that
        // cell is occupied. This prevents a release from landing half-on a
        // neighbouring button or overlapping another block.
        for (let radius = 0; radius <= 2; radius++) {
            for (let xOffset = -radius; xOffset <= radius; xOffset++) {
                for (let zOffset = -radius; zOffset <= radius; zOffset++) {
                    if (Math.max(Math.abs(xOffset), Math.abs(zOffset)) !== radius) continue;
                    const candidate = new Vec3(baseX + xOffset, current.y, baseZ + zOffset);
                    this.keepInsideBoardColliders(block, candidate);
                    if (!this.canPlaceWithoutOverlap(block, candidate)) continue;
                    const distance = this.planarDistanceSquared(candidate, current);
                    if (distance < bestDistance) {
                        best = candidate;
                        bestDistance = distance;
                    }
                }
            }
            if (best) break;
        }
        if (best) block.setWorldPosition(best);
    }

    private readBoardInterior(): Rect | null {
        if (!this.boardPhysical) return null;
        let minX = Number.NEGATIVE_INFINITY, maxX = Number.POSITIVE_INFINITY;
        let minZ = Number.NEGATIVE_INFINITY, maxZ = Number.POSITIVE_INFINITY;
        let xWalls = false, zWalls = false;
        const origin = this.boardPhysical.worldPosition;
        for (const wall of this.boardPhysical.getComponents(BoxCollider)) {
            const bounds = this.worldBounds(wall);
            const centerX = (bounds.minX + bounds.maxX) * 0.5;
            const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
            const halfX = (bounds.maxX - bounds.minX) * 0.5;
            const halfZ = (bounds.maxZ - bounds.minZ) * 0.5;
            if (halfX < halfZ) {
                xWalls = true;
                if (centerX < origin.x) minX = Math.max(minX, centerX + halfX);
                else maxX = Math.min(maxX, centerX - halfX);
            } else {
                zWalls = true;
                if (centerZ < origin.z) minZ = Math.max(minZ, centerZ + halfZ);
                else maxZ = Math.min(maxZ, centerZ - halfZ);
            }
        }
        return xWalls && zWalls ? { minX, maxX, minZ, maxZ } : null;
    }

    private colliderRects(root: Node, rootPosition: Readonly<Vec3>): Rect[] {
        const colliders = root.getComponents(BoxCollider);
        if (colliders.length === 0) return [{ minX: rootPosition.x - 0.9, maxX: rootPosition.x + 0.9, minZ: rootPosition.z - 0.9, maxZ: rootPosition.z + 0.9 }];
        const delta = new Vec3();
        Vec3.subtract(delta, rootPosition, root.worldPosition);
        return colliders.map((collider) => {
            const bounds = this.worldBounds(collider);
            return {
                minX: bounds.minX + delta.x - 0.03,
                maxX: bounds.maxX + delta.x + 0.03,
                minZ: bounds.minZ + delta.z - 0.03,
                maxZ: bounds.maxZ + delta.z + 0.03,
            };
        });
    }

    private shredderExitNormal(block: Node, shredder: Node) {
        const center = this.boardPhysical?.worldPosition || Vec3.ZERO;
        const areaCollider = shredder.getComponent(Shredder)?.dropColliders()[0] || null;
        const areaBounds = areaCollider ? this.worldBounds(areaCollider) : null;
        const gateCenterX = areaBounds ? (areaBounds.minX + areaBounds.maxX) * 0.5 : shredder.worldPosition.x;
        const gateCenterZ = areaBounds ? (areaBounds.minZ + areaBounds.maxZ) * 0.5 : shredder.worldPosition.z;
        const dx = gateCenterX - center.x;
        const dz = gateCenterZ - center.z;
        return Math.abs(dx) > Math.abs(dz)
            ? new Vec3(dx >= 0 ? 1 : -1, 0, 0)
            : new Vec3(0, 0, dz >= 0 ? 1 : -1);
    }

    private shredderExitWorld(block: Node, shredder: Node, normal: Readonly<Vec3>) {
        const collider = this.shredderRootCollider(shredder);
        if (!collider) return shredder.worldPosition.clone();
        const bounds = this.worldBounds(collider);
        const exit = block.worldPosition.clone();
        if (Math.abs(normal.z) > 0) exit.z = normal.z > 0 ? bounds.maxZ + this.blockHalfExtent(block, 'z') : bounds.minZ - this.blockHalfExtent(block, 'z');
        else exit.x = normal.x > 0 ? bounds.maxX + this.blockHalfExtent(block, 'x') : bounds.minX - this.blockHalfExtent(block, 'x');
        return exit;
    }

    private playCameraImpact(direction: Readonly<Vec3>) {
        if (!this.camera?.node?.isValid) return;
        const node = this.camera.node;
        const home = node.worldPosition.clone();
        const lateral = new Vec3(-direction.z, 0, direction.x);
        const state = { t: 0 };
        Tween.stopAllByTarget(state);
        tween(state)
            .to(0.045, { t: 1 }, {
                easing: 'quadOut',
                onUpdate: () => node.setWorldPosition(new Vec3(home.x - direction.x * 0.075 + lateral.x * 0.028, home.y, home.z - direction.z * 0.075 + lateral.z * 0.028)),
            })
            .to(0.14, { t: 0 }, {
                easing: 'quadInOut',
                onUpdate: () => node.setWorldPosition(new Vec3(home.x - direction.x * 0.075 * state.t + lateral.x * 0.028 * state.t, home.y, home.z - direction.z * 0.075 * state.t + lateral.z * 0.028 * state.t)),
            })
            .call(() => { if (node.isValid) node.setWorldPosition(home); })
            .start();
    }

    private blockHalfExtent(block: Node, axis: 'x' | 'z') {
        const colliders = this.allBoxColliders(block);
        if (colliders.length === 0) return 0.5;
        let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY;
        for (const collider of colliders) {
            const bounds = this.worldBounds(collider);
            min = Math.min(min, axis === 'x' ? bounds.minX : bounds.minZ);
            max = Math.max(max, axis === 'x' ? bounds.maxX : bounds.maxZ);
        }
        return Math.max(0.1, (max - min) * 0.5);
    }

    private shredderRootCollider(shredder: Node) {
        return this.allBoxColliders(shredder).find((collider) => collider.node === shredder && !collider.isTrigger) || null;
    }

    private allBoxColliders(root: Node) {
        const result: BoxCollider[] = [];
        const visit = (node: Node) => {
            result.push(...node.getComponents(BoxCollider));
            for (const child of node.children) visit(child);
        };
        visit(root);
        return result;
    }

    private worldBounds(collider: BoxCollider): Bounds3D {
        const world = collider.worldBounds;
        const center = world.center;
        const half = world.halfExtents;
        return { minX: center.x - half.x, maxX: center.x + half.x, minY: center.y - half.y, maxY: center.y + half.y, minZ: center.z - half.z, maxZ: center.z + half.z };
    }

    private boundsIntersect(a: Bounds3D, b: Bounds3D) {
        return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ;
    }

    private rectanglesOverlap(a: Rect, b: Rect) {
        return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
    }

    private blockMainColour(block: Node): Color | null {
        for (const material of this.sharedMaterials(block)) {
            const value = material.getProperty('mainColor') as Color | null;
            if (value && typeof value.r === 'number') return new Color(value.r, value.g, value.b, value.a);
        }
        return null;
    }

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

    private findDescendant(root: Node, name: string): Node | null {
        if (root.name === name) return root;
        for (const child of root.children) {
            const match = this.findDescendant(child, name);
            if (match) return match;
        }
        return null;
    }
}
