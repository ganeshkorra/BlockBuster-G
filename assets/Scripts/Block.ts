import { _decorator, Component } from 'cc';

const { ccclass } = _decorator;

/**
 * Compatibility component retained by the existing block prefabs.
 * Drag behaviour is coordinated by GameManager; this class keeps legacy prefab
 * instances deserializable without changing their mesh, collider, or material.
 */
@ccclass('Block')
export class Block extends Component {}
