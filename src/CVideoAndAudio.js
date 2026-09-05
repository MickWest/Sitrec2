import {CVideoData} from "./CVideoData";
import {CAudioMp4Data} from "./CAudioMp4Data";

/**
 * Intermediate class that extends CVideoData to add audio support
 * Provides common audio functionality for video classes that need audio playback
 * 
 * Key responsibilities:
 * - Manages audio handler instance
 * - Provides audio playback control methods
 * - Handles audio initialization and disposal
 * - Coordinates audio-video synchronization
 */
export class CVideoAndAudio extends CVideoData {
    constructor(v) {
        super(v);
        
        this.audioHandler = null;
        this._audioWaitTimeout = null;
        this._pendingPromises = [];
    }

    /**
     * Initialize audio handler if not already initialized
     * @param {Object} videoData - Video data object for audio handler
     * @returns {CAudioMp4Data|null} The audio handler instance
     */
    initializeAudioHandler(videoData) {
        if (!this.audioHandler) {
            this.audioHandler = new CAudioMp4Data(videoData || this);
        }
        return this.audioHandler;
    }

    /**
     * Check if audio is currently playing and not muted
     * Used to coordinate decoder priorities
     * @returns {boolean} True if audio is actively playing
     */
    isAudioActive() {
        return this.audioHandler && 
               this.audioHandler.isPlaying && 
               !this.audioHandler.isMuted;
    }

    /**
     * Check if audio buffer is ready for playback
     * @returns {boolean} True if audio is ready
     */
    isAudioReady() {
        if (this.audioHandler?.streamAudio) return true;
        return this.audioHandler && 
               this.audioHandler._bufferCreatedSuccessfully && 
               this.audioHandler.audioBuffer;
    }

    /**
     * Play audio synchronized with video frame
     * @param {number} frame - Current video frame
     * @param {number} fps - Frames per second
     */
    playAudio(frame, fps) {
        if (this.audioHandler) {
            this.audioHandler.play(frame, fps);
        }
    }

    /**
     * Pause audio playback
     */
    pauseAudio() {
        if (this.audioHandler) {
            this.audioHandler.pause();
        }
    }

    /**
     * Stop audio playback completely
     */
    stopAudio() {
        if (this.audioHandler) {
            this.audioHandler.stop();
        }
    }

    /**
     * Set audio volume
     * @param {number} volume - Volume level (0.0 to 1.0)
     */
    setAudioVolume(volume) {
        if (this.audioHandler) {
            this.audioHandler.setVolume(volume);
        }
    }

    /**
     * Mute or unmute audio
     * @param {boolean} muted - True to mute, false to unmute
     */
    setAudioMuted(muted) {
        if (this.audioHandler) {
            this.audioHandler.setMuted(muted);
        }
    }

    /**
     * Clean up audio resources
     */
    disposeAudio() {
        // Clear any pending audio wait timeout
        if (this._audioWaitTimeout) {
            clearTimeout(this._audioWaitTimeout);
            this._audioWaitTimeout = null;
        }
        
        // Clear all pending promises
        this._pendingPromises = [];
        
        if (this.audioHandler) {
            // First stop the audio to ensure playback is halted
            this.audioHandler.stop();
            // Then dispose of all resources
            this.audioHandler.dispose();
            this.audioHandler = null;
        }
    }

    /**
     * Override dispose to clean up audio resources
     */
    dispose() {
        this.disposeAudio();
        super.dispose();
    }
}
