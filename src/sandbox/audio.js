class AudioManager {
    constructor() {
        this.ctx = null;
        this.enabled = true;
    }

    init() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    playTone(freq, type, duration, vol = 0.1) {
        if (!this.enabled) return;
        try {
            this.init();
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(vol, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start();
            osc.stop(this.ctx.currentTime + duration);
        } catch (e) {
            console.warn('Audio error:', e);
        }
    }

    playCountdown(isGo = false) {
        if (isGo) {
            this.playTone(880, 'sine', 0.6, 0.2);
        } else {
            this.playTone(440, 'sine', 0.3, 0.15);
        }
    }

    playJump() {
        this.playTone(523.25, 'triangle', 0.25, 0.1);
    }

    playCoin() {
        this.playTone(987.77, 'sine', 0.15, 0.15);
        setTimeout(() => this.playTone(1318.51, 'sine', 0.2, 0.15), 80);
    }

    playCrash() {
        if (!this.enabled) return;
        try {
            this.init();
            const bufferSize = this.ctx.sampleRate * 0.5;
            const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            const noise = this.ctx.createBufferSource();
            noise.buffer = buffer;
            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.5);
            noise.connect(gain);
            gain.connect(this.ctx.destination);
            noise.start();
        } catch (e) {
            console.warn('Crash audio error:', e);
        }
    }

    playShield() {
        this.playTone(659.25, 'sine', 0.3, 0.15);
    }
}

window.audioManager = new AudioManager();
