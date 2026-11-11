// Runs on the audio thread: hands the microphone's samples to listen.js a tenth of a second at a
// time. Each message is { pcm, frame }: mono samples, and how many frames the audio clock had counted
// at the end of the last one, which is what gives the block its time (see createClock in
// listen-view.js). Nothing is played: the node has no output.

class Tap extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    // The engine takes up to 48 kHz. A faster device (96 or 192 kHz) is cut down by averaging `every`
    // samples into one, which is filter enough for a band that stops at 4 kHz.
    this.every = processorOptions.every;
    this.size = Math.round(sampleRate / this.every / 10);
    this.block = new Float32Array(this.size);
    this.fill = this.sum = this.count = 0;
  }

  process([[input]]) {
    if (!input) return true; // nothing connected yet
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      if (++this.count < this.every) continue;
      this.block[this.fill++] = this.sum / this.every;
      this.sum = this.count = 0;
      if (this.fill < this.size) continue;
      this.port.postMessage({ pcm: this.block, frame: currentFrame + i + 1 }, [this.block.buffer]);
      this.block = new Float32Array(this.size);
      this.fill = 0;
    }
    return true;
  }
}
registerProcessor('hfs-tap', Tap);
