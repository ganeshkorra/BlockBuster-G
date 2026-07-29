import { _decorator, AudioSource, Component, ParticleSystem } from 'cc';

const { ccclass } = _decorator;

/**
 * Compatibility component retained by the existing Shredder prefab.
 * GameManager calls the same feedback directly when a matching block is dropped.
 */
@ccclass('Shredder')
export class Shredder extends Component {
    playFeedback() {
        this.getComponentInChildren(ParticleSystem)?.play();
        this.getComponent(AudioSource)?.play();
    }
}
