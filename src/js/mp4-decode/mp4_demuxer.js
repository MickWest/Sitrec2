import MP4Box from "../mp4box.all";
//var MP4Box = require('mp4box');  // node.js version
import {Sit} from "../../Globals";
import {extractAllMetaData} from "../../ExtractMetadata";

export class MP4Source {
  constructor() {
    this.file = MP4Box.createFile();
    this.file.onError = console.error.bind(console);
    this.file.onReady = this.onReady.bind(this);
    this.file.onSamples = this.onSamples.bind(this);

    this.info = null;
    this._info_resolver = null;
    this._extractedTracks = new Set();
    this._extractionCompleteCallback = null;
    this._expectedVideoSamples = 0;
    this._expectedAudioSamples = 0;
    this._receivedVideoSamples = 0;
    this._receivedAudioSamples = 0;
  }

  loadURI(uri, callback, error) {
    fetch(uri).then(response => {
      const reader = response.body.getReader();
      if (response.status === 200) {
        this.loadFromReader(reader, callback)
      } else {
        if (error !== undefined) {
          error(uri)
        }
      }
    })
  }


  loadFromReader(reader, callback) {
    let offset = 0;
    let mp4File = this.file;

    function appendBuffers({done, value}) {
      if (done) {
        mp4File.flush();
        callback()
        return;
      }
//      console.log("appendBuffers value.length = " + value.length + " done = " + done)

      let buf = value.buffer;
      buf.fileStart = offset;

      offset += buf.byteLength;

      mp4File.appendBuffer(buf);

      return reader.read().then(appendBuffers);
    }

    return reader.read().then(appendBuffers);
  }


  onReady(info) {

    const meta = extractAllMetaData(this.file.boxes);
    if (meta) {
        Sit.metadata = meta;
        console.log("MP4Source onReady metadata = ", Sit.metadata);
    }

    // TODO: Generate configuration changes.
    this.info = info;
    //console.log("MP4Source onReady info = ", info)
    var videoTrack = info.tracks.find(track => track.type === 'video');

    // Check if the video track has a sync sample (stss) table.
    // VLC-exported MP4s often omit stss, causing MP4Box to mark ALL frames
    // as keyframes. For H.264 we fall back to bitstream inspection of NAL
    // unit types; HEVC uses a different NAL header layout so we leave the
    // MP4Box default (all-sync) in place for HEVC files without stss.
    this._hasStssTable = true;
    this._nalLengthSize = 4; // default AVCC NAL length prefix size
    if (videoTrack) {
      const trak = this.file.getTrackById(videoTrack.id);
      const stss = trak?.mdia?.minf?.stbl?.stss;
      if (!stss) {
        const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
        if (entry?.avcC) {
          // H.264: enable bitstream-based keyframe detection
          console.warn("⚠️ MP4 file has no sync sample (stss) table — keyframes will be detected from H.264 bitstream");
          this._hasStssTable = false;
          this._nalLengthSize = (entry.avcC.lengthSizeMinusOne || 3) + 1;
        } else {
          // HEVC or other codec: log a warning but don't enable the H.264
          // detector — the all-sync fallback from MP4Box is safer here.
          console.warn("⚠️ MP4 file has no sync sample (stss) table and codec is not H.264 — keyframe detection unavailable");
        }
      }
    }
    
    // Get duration from video or audio track
    var durationTrack = videoTrack || info.tracks.find(track => track.type === 'audio');
    
    if (durationTrack) {
      var duration = durationTrack.movie_duration; // Duration in timescale units
      var timescale = durationTrack.movie_timescale; // Timescale (units per second)
      this.durationInSeconds = duration / timescale;
      this.duration = (duration / timescale) * 1000000; // Convert to microseconds for audio-only duration calculation

      console.log('Duration: ', duration, 'Timescale: ', timescale);
      console.log('Duration in seconds = ' + this.durationInSeconds);
    }
    
    if (videoTrack) {
      // var frameRate = videoTrack.video.sample_entries[0].sample_rate || calculateFrameRate(videoTrack);
      //
      // var totalFrames = (frameRate * duration) / timescale;

      this.totalFrames = videoTrack.nb_samples;
      console.log('Estimated Number of Frames: ', this.totalFrames);
      
      this._expectedVideoSamples = videoTrack.nb_samples;

      var framesPerSecond = this.totalFrames / this.durationInSeconds;
      // we want whole numbers like 30,60,50,25,24, or NTSC 29.97
      // so round to nearest 0.01
      framesPerSecond = Math.round(framesPerSecond * 100) / 100;

        console.log('Frames Per Second: ', framesPerSecond);

      // is it something reasonable?
        if (framesPerSecond > 0 && framesPerSecond <= 240) {
            this.fps = framesPerSecond;
        } else {
            console.warn('Invalid frame rate: ', framesPerSecond, " setting to 30");
            this.fps = 30;
        }
    }

    // Find all audio tracks
    var audioTracks = info.tracks.filter(track => track.type === 'audio');
    
    if (audioTracks.length > 0) {
      console.log('Found', audioTracks.length, 'audio track(s)');
      
      // Prefer AAC/MP4A audio tracks over others (APAC, MEBX, etc.)
      // iPhone MOV files often have multiple audio tracks
      var preferredTrack = audioTracks.find(track => {
        const codec = track.codec ? track.codec.toLowerCase() : '';
        return codec.includes('mp4a') || codec.includes('aac');
      });
      
      // If no AAC track found, try to find any supported audio track
      if (!preferredTrack) {
        preferredTrack = audioTracks.find(track => {
          const codec = track.codec ? track.codec.toLowerCase() : '';
          // Exclude known problematic codecs
          return !codec.includes('apac') && !codec.includes('mebx') && !codec.includes('opus');
        });
      }
      
      // Fall back to first audio track if no preferred track found
      this.audioTrack = preferredTrack || audioTracks[0];
      
      console.log('Selected audio track:', this.audioTrack);
      console.log('Audio codec:', this.audioTrack.codec);
      this._expectedAudioSamples = this.audioTrack.nb_samples;
      console.log('Expected audio samples:', this._expectedAudioSamples);
    } else {
      console.log('No audio tracks found');
    }

    console.log('[MP4Source.onReady] About to resolve: this._info_resolver=', typeof this._info_resolver, 'this.info=', this.info ? 'SET' : 'NULL');
    if (this._info_resolver) {
      console.log('[MP4Source.onReady] Resolving with info:', this.info ? 'yes' : 'no');
      this._info_resolver(info);
      this._info_resolver = null;
    } else {
      console.warn('[MP4Source.onReady] WARNING: No resolver set when onReady fired!');
    }
    console.log('[MP4Source.onReady] Done');
  }

  getInfo() {
    if (this.info) {
      console.log('[MP4Source.getInfo] Info already set, returning resolved promise');
      return Promise.resolve(this.info);
    }

    console.log('[MP4Source.getInfo] Info not ready, creating new promise and setting resolver');
    return new Promise((resolver) => { 
      this._info_resolver = resolver; 
      console.log('[MP4Source.getInfo] Promise created and resolver stored');
    });
  }

  getCodecConfigBox() {
    const traks = this.file.moov.traks;
    for (const trak of traks) {
      const entry = trak.mdia?.minf?.stbl?.stsd?.entries?.[0];
      if (!entry) continue;
      
      if (entry.avcC) {
        return { box: entry.avcC, type: 'avc' };
      }
      if (entry.hvcC) {
        return { box: entry.hvcC, type: 'hevc' };
      }
    }
    return null;
  }

  getAvccBox() {
    const config = this.getCodecConfigBox();
    if (!config || config.type !== 'avc') {
      return null;
    }
    return config.box;
  }

  start(track, onChunk) {
    this._onChunk = onChunk;
    this.videoTrackId = track.id;
    this.file.setExtractionOptions(track.id);
    if (!this._extractionStarted) {
      // Set flag before file.start() because start() can call onSamples
      // synchronously. If the callback throws, the flag must already be
      // set to prevent the catch handler from calling start() again.
      this._extractionStarted = true;
      this.file.start();
    }
  }

  startWithAudio(videoTrack, audioTrack, onChunk, onAudioSamples) {
    this._onChunk = onChunk;
    this._onAudioSamples = onAudioSamples;
    this.videoTrackId = videoTrack.id;
    
    console.log("MP4Source.startWithAudio: videoTrack.id=", videoTrack.id);
    
    this.file.setExtractionOptions(videoTrack.id);
    
    if (audioTrack) {
      this.audioTrackId = audioTrack.id;
      console.log("MP4Source.startWithAudio: audioTrack.id=", audioTrack.id, "setting extraction options");
      this.file.setExtractionOptions(audioTrack.id);
    } else {
      console.warn("MP4Source.startWithAudio: no audioTrack provided");
    }
    
    if (!this._extractionStarted) {
      console.log("MP4Source.startWithAudio: calling file.start()");
      // Set flag before file.start() - see comment in start() above
      this._extractionStarted = true;
      this.file.start();
    }
  }

  startAudio(track, onAudioChunk, onAudioSamples) {
    this._onAudioChunk = onAudioChunk;
    this._onAudioSamples = onAudioSamples;
    this.audioTrackId = track.id;
    this.file.setExtractionOptions(track.id);
    if (!this._extractionStarted) {
      // Set flag before file.start() - see comment in start() above
      this._extractionStarted = true;
      this.file.start();
    }
  }

  /**
   * Detect whether an AVCC-formatted sample is a true IDR keyframe
   * by inspecting the H.264 NAL unit types in the sample data.
   * NAL type 5 = IDR slice (keyframe), NAL type 1 = non-IDR slice (delta).
   */
  _detectKeyframeFromBitstream(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    const nalLengthSize = this._nalLengthSize;

    while (offset + nalLengthSize < data.byteLength) {
      let nalLength = 0;
      if (nalLengthSize === 4) {
        nalLength = view.getUint32(offset);
      } else if (nalLengthSize === 2) {
        nalLength = view.getUint16(offset);
      } else {
        nalLength = view.getUint8(offset);
      }
      offset += nalLengthSize;

      if (nalLength === 0 || offset + nalLength > data.byteLength) break;

      const nalType = data[offset] & 0x1F;
      if (nalType === 5) return "key";   // IDR slice — true keyframe
      if (nalType === 1) return "delta"; // Non-IDR slice — P/B frame
      // Skip SEI (6), SPS (7), PPS (8) and other non-slice NAL units
      offset += nalLength;
    }

    // If we couldn't determine, assume key (safe default — decoder will reject if wrong)
    return "key";
  }

  onSamples(track_id, ref, samples) {
    if (track_id === this.videoTrackId) {
      this._receivedVideoSamples += samples.length;
      for (const sample of samples) {
        let type = sample.is_sync ? "key" : "delta";

        // When stss table is missing, MP4Box marks ALL frames as keyframes.
        // Detect actual keyframes from the H.264 bitstream instead.
        if (!this._hasStssTable && sample.is_sync && sample.data) {
          type = this._detectKeyframeFromBitstream(sample.data);
        }

        const chunk = new EncodedVideoChunk({
          type: type,
          timestamp: sample.cts,
          duration: sample.duration,
          data: sample.data
        });

        this._onChunk(chunk);
      }
    } else if (track_id === this.audioTrackId) {
      this._receivedAudioSamples += samples.length;
      if (this._onAudioSamples) {
//        console.log("MP4Source.onSamples: routing", samples.length, "audio samples to callback (total:", this._receivedAudioSamples, "/", this._expectedAudioSamples, ")");
        this._onAudioSamples(track_id, samples);
      } else {
        console.warn("MP4Source.onSamples: audio track_id=", track_id, "but no _onAudioSamples callback");
      }
    } else {
      console.log("MP4Source.onSamples: received track_id=", track_id, "videoTrackId=", this.videoTrackId, "audioTrackId=", this.audioTrackId);
    }
    
    this._checkExtractionComplete();
  }
  
  _checkExtractionComplete() {
    if (!this._extractionCompleteCallback) return;
    
    const videoComplete = this._expectedVideoSamples === 0 || (this._expectedVideoSamples > 0 && this._receivedVideoSamples >= this._expectedVideoSamples);
    const audioComplete = this._expectedAudioSamples === 0 || this._receivedAudioSamples >= this._expectedAudioSamples;
    
    if (videoComplete && audioComplete) {
      console.log("Extraction complete: video=", this._receivedVideoSamples, "/", this._expectedVideoSamples, "audio=", this._receivedAudioSamples, "/", this._expectedAudioSamples);
      this.cancelExtractionTimeout();
      const callback = this._extractionCompleteCallback;
      this._extractionCompleteCallback = null;
      callback();
    }
  }
  
  onExtractionComplete(callback, timeoutMs = 30000) {
    this._extractionCompleteCallback = callback;
    this._extractionStartTime = Date.now();
    
    // Set a timeout to force completion even if not all samples arrive
    // This prevents stuck loading under high resource usage
    this._extractionTimeout = setTimeout(() => {
      if (this._extractionCompleteCallback) {
        console.warn(`[MP4Source] Extraction timeout after ${timeoutMs}ms. Received: video=${this._receivedVideoSamples}/${this._expectedVideoSamples}, audio=${this._receivedAudioSamples}/${this._expectedAudioSamples}`);
        const cb = this._extractionCompleteCallback;
        this._extractionCompleteCallback = null;
        cb();
      }
    }, timeoutMs);
    
    this._checkExtractionComplete();
  }
  
  cancelExtractionTimeout() {
    if (this._extractionTimeout) {
      clearTimeout(this._extractionTimeout);
      this._extractionTimeout = null;
    }
  }
}

class Writer {
  constructor(size) {
    this.data = new Uint8Array(size);
    this.idx = 0;
    this.size = size;
  }

  getData() {
    if(this.idx != this.size)
      throw "Mismatch between size reserved and sized used"

    return this.data.slice(0, this.idx);
  }

  writeUint8(value) {
    this.data.set([value], this.idx);
    this.idx++;
  }

  writeUint16(value) {
    this.data.set([(value >> 8) & 0xFF, value & 0xFF], this.idx);
    this.idx += 2;
  }

  writeUint32(value) {
    this.data.set([
      (value >> 24) & 0xFF,
      (value >> 16) & 0xFF,
      (value >> 8) & 0xFF,
      value & 0xFF
    ], this.idx);
    this.idx += 4;
  }

  writeUint8Array(value) {
    this.data.set(value, this.idx);
    this.idx += value.length;
  }
}

export class MP4Demuxer {

  constructor(source) {
    this.source = source;
    this.audioTrack = null;
    this._extractionStarted = false;
    this.videoTrackId = null;
    this.audioTrackId = null;
    this.videoTrack = null;
    this._audioCallbackReady = false;
    this._pendingAudioCallback = null;
    this._extractionComplete = false;
    this._completionResolvers = [];
  }

  onExtractionComplete() {
    this._extractionComplete = true;
    this._completionResolvers.forEach(resolve => resolve());
    this._completionResolvers = [];
  }

  waitForExtractionComplete() {
    if (this._extractionComplete) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this._completionResolvers.push(resolve);
    });
  }

  getExtradata(avccBox) {
    var i;
    var size = 7;
    for (i = 0; i < avccBox.SPS.length; i++) {
      size+= 2 + avccBox.SPS[i].length;
    }
    for (i = 0; i < avccBox.PPS.length; i++) {
      size+= 2 + avccBox.PPS[i].length;
    }

    var writer = new Writer(size);

    writer.writeUint8(avccBox.configurationVersion);
    writer.writeUint8(avccBox.AVCProfileIndication);
    writer.writeUint8(avccBox.profile_compatibility);
    writer.writeUint8(avccBox.AVCLevelIndication);
    writer.writeUint8(avccBox.lengthSizeMinusOne + (63<<2));

    writer.writeUint8(avccBox.nb_SPS_nalus + (7<<5));
    for (i = 0; i < avccBox.SPS.length; i++) {
      writer.writeUint16(avccBox.SPS[i].length);
      writer.writeUint8Array(avccBox.SPS[i].nalu);
    }

    writer.writeUint8(avccBox.nb_PPS_nalus);
    for (i = 0; i < avccBox.PPS.length; i++) {
      writer.writeUint16(avccBox.PPS[i].length);
      writer.writeUint8Array(avccBox.PPS[i].nalu);
    }

    return writer.getData();
  }

  getHvccExtradata(hvccBox) {
    var size = 23;
    for (const naluArray of hvccBox.nalu_arrays) {
      size += 3;
      for (const nalu of naluArray) {
        if (nalu.data) {
          size += 2 + nalu.data.length;
        }
      }
    }

    var writer = new Writer(size);

    writer.writeUint8(hvccBox.configurationVersion);
    writer.writeUint8(
      (hvccBox.general_profile_space << 6) |
      ((hvccBox.general_tier_flag ? 1 : 0) << 5) |
      hvccBox.general_profile_idc
    );
    writer.writeUint32(hvccBox.general_profile_compatibility);
    for (var i = 0; i < 6; i++) {
      writer.writeUint8(hvccBox.general_constraint_indicator[i]);
    }
    writer.writeUint8(hvccBox.general_level_idc);
    writer.writeUint16(0xF000 | hvccBox.min_spatial_segmentation_idc);
    writer.writeUint8(0xFC | hvccBox.parallelismType);
    writer.writeUint8(0xFC | hvccBox.chroma_format_idc);
    writer.writeUint8(0xF8 | hvccBox.bit_depth_luma_minus8);
    writer.writeUint8(0xF8 | hvccBox.bit_depth_chroma_minus8);
    writer.writeUint16(hvccBox.avgFrameRate);
    writer.writeUint8(
      (hvccBox.constantFrameRate << 6) |
      (hvccBox.numTemporalLayers << 3) |
      ((hvccBox.temporalIdNested ? 1 : 0) << 2) |
      hvccBox.lengthSizeMinusOne
    );
    writer.writeUint8(hvccBox.nalu_arrays.length);

    for (const naluArray of hvccBox.nalu_arrays) {
      writer.writeUint8(
        ((naluArray.completeness ? 1 : 0) << 7) | naluArray.nalu_type
      );
      const nalusWithData = naluArray.filter(n => n.data);
      writer.writeUint16(nalusWithData.length);
      for (const nalu of nalusWithData) {
        writer.writeUint16(nalu.data.length);
        writer.writeUint8Array(nalu.data);
      }
    }

    return writer.getData();
  }

  async getConfig() {
    let info = await this.source.getInfo();
    this.videoTrack = info.videoTracks[0];

    if (!this.videoTrack) {
      const videoTrack = info.tracks?.find(track => track.type === 'video');
      if (videoTrack) {
        const codec = videoTrack.codec || videoTrack.video?.codec || "unknown";
        const codecName = codec.toLowerCase().includes("apcn") || codec.toLowerCase().includes("apch") ||
          codec.toLowerCase().includes("apcs") || codec.toLowerCase().includes("apco") ||
          codec.toLowerCase().includes("ap4h") || codec.toLowerCase().includes("ap4x")
          ? "Apple ProRes"
          : codec;
        const dimensions = videoTrack.video?.width && videoTrack.video?.height
          ? ` (${videoTrack.video.width}x${videoTrack.video.height})`
          : "";
        throw new Error(
          `Unsupported MOV/MP4 video codec: ${codecName} (${codec})${dimensions}. ` +
          `Sitrec can load browser-decodable H.264/HEVC MP4/MOV files, but this file's video track is not exposed to WebCodecs. ` +
          `Convert it with: ffmpeg -i input.mov -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart output.mp4`
        );
      }
      throw new Error("No video track found in file. If this is a MOV/MP4, it may contain only unsupported data tracks or metadata.");
    }

    const codecConfig = this.source.getCodecConfigBox();
    if (!codecConfig) {
      throw new Error("Unsupported video codec - no avcC or hvcC configuration found");
    }

    let extradata;
    if (codecConfig.type === 'avc') {
      extradata = this.getExtradata(codecConfig.box);
    } else if (codecConfig.type === 'hevc') {
      extradata = this.getHvccExtradata(codecConfig.box);
    } else {
      throw new Error(`Unsupported codec type: ${codecConfig.type}`);
    }

    let config = {
      codec: this.videoTrack.codec,
      codedHeight: this.videoTrack.video.height,
      codedWidth: this.videoTrack.video.width,
      description: extradata,
    }

    return Promise.resolve(config);
  }

  start(onChunk, onAudioSamples, onComplete) {
    this._pendingAudioCallback = onAudioSamples;
    
    // For audio-only files, use startAudio instead of startWithAudio
    if (!this.videoTrack && this.audioTrack) {
      console.log("Starting audio-only extraction");
      this.source.startAudio(this.audioTrack, onChunk, onAudioSamples);
    } else if (this.videoTrack) {
      // For video files with optional audio
      this.source.startWithAudio(this.videoTrack, this.audioTrack, onChunk, onAudioSamples);
    } else {
      console.warn("No video or audio track available for extraction");
      return;
    }
    
    if (onComplete) {
      this.source.onExtractionComplete(onComplete);
    }
  }

  async getAudioConfig() {
    let info = await this.source.getInfo();
    
    // Get audio track from the source (which was set in onReady)
    this.audioTrack = this.source.audioTrack;
    
    if (!this.audioTrack) {
      console.log("No audio track found in MP4Source");
      return null;
    }

    if (!this.audioTrack.audio) {
      console.warn("Audio track missing audio property");
      return null;
    }
    
    // Ensure codec string is properly formatted
    let codec = this.audioTrack.codec;
    if (!codec) {
      console.warn("No codec specified for audio track");
      return null;
    }
    
    // Handle codec string format (e.g., "mp4a.40.2" for AAC-LC)
    // Some files might have different formats that need normalization
    if (codec.toLowerCase().includes('mp4a') && !codec.includes('.')) {
      // If it's mp4a without dots, try to format it properly
      codec = 'mp4a.40.2'; // Default to AAC-LC
    }
    
    // MP4Box.js now correctly parses QuickTime V1/V2 audio sample entries
    // Use audio.sample_rate which is now correct for all formats
    const sampleRate = this.audioTrack.audio.sample_rate;
    const numberOfChannels = this.audioTrack.audio.channel_count;
    
    console.log("[MP4Demuxer] Audio config from MP4Box:");
    console.log("[MP4Demuxer]   Sample rate:", sampleRate, "Hz");
    console.log("[MP4Demuxer]   Channels:", numberOfChannels);
    
    let config = {
      codec: codec,
      numberOfChannels: numberOfChannels,
      sampleRate: sampleRate,
    };
    
    // For AAC codecs (mp4a.40.x), we need to provide the AudioSpecificConfig as description
    // This is required for the AudioDecoder to properly decode the stream
    if (codec.toLowerCase().startsWith('mp4a')) {
      try {
        // Try to get the description from the track's sample entry
        // MP4Box stores the AudioSpecificConfig in different places depending on the container
        const track = this.audioTrack;
        
        // Look for esds box which contains the decoder config for AAC
        // The path varies but typically it's in the sample description
        let description = null;
        
        // Try getting from the file's getTrackById which has more complete info
        const trackInfo = this.source.file.getTrackById(track.id);
        if (trackInfo && trackInfo.mdia && trackInfo.mdia.minf && trackInfo.mdia.minf.stbl && 
            trackInfo.mdia.minf.stbl.stsd && trackInfo.mdia.minf.stbl.stsd.entries) {
          const entry = trackInfo.mdia.minf.stbl.stsd.entries[0];
          if (entry && entry.esds && entry.esds.esd && entry.esds.esd.descs) {
            // Navigate to the DecoderSpecificInfo
            for (const desc of entry.esds.esd.descs) {
              if (desc.descs) {
                for (const subdesc of desc.descs) {
                  if (subdesc.data) {
                    description = subdesc.data;
                    break;
                  }
                }
              }
              if (description) break;
            }
          }
        }
        
        if (description) {
          config.description = description;
          console.log("[MP4Demuxer]   Description (AudioSpecificConfig):", description.byteLength, "bytes");
        } else {
          console.warn("[MP4Demuxer]   No AudioSpecificConfig found for AAC track");
        }
      } catch (e) {
        console.warn("[MP4Demuxer]   Error extracting AudioSpecificConfig:", e);
      }
    }
    
    console.log("Audio config prepared:", config);

    return config;
  }

  startAudio(onAudioSamples) {
    if (!this.audioTrack) {
      return;
    }
    this.source.startAudio(this.audioTrack, null, onAudioSamples);
  }
}
