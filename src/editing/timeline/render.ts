import { sampleRate } from "../processor";
import { RenderMessage, RenderMessageCreate, RenderMessageDraw } from "./renderController";

let offscreen: OffscreenCanvas;
let gl: WebGL2RenderingContext;
let vertices: Float32Array;
let program: WebGLProgram;

type Message = {
  data: RenderMessage
};

const renderPixelSize = Math.round(sampleRate / 1000);

self.addEventListener('message', ({data}: Message) => {
  if (data.type === "create") {
    setup(data);
  } else if (data.type === "draw") {
    drawWaveform(data);
  }
});

function setup({ canvas, channel0, channel1 }: RenderMessageCreate) {
  offscreen = canvas;
  gl = canvas.getContext("webgl2", {preserveDrawingBuffer: true}) as WebGL2RenderingContext;
  init(gl);

  vertices = preprocess(channel0, channel1);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
}

function preprocess(channel0: Float32Array, channel1: Float32Array): Float32Array {
  const outputLength = Math.ceil(channel0.length / renderPixelSize);
  const output = new Float32Array(outputLength * 4);

  for(let i = 0; i < outputLength; i++) {
    let min = 1;
    let max = -1;

    for(let j = 0; j < renderPixelSize; j++) {
      const idx = i * renderPixelSize + j;
      if (idx < channel0.length) {
        const val0 = channel0[idx];
        const val1 = channel1[idx];
        min = Math.min(min, val0, val1);
        max = Math.max(max, val0, val1);
      }
    }

    const xSamples = i * renderPixelSize;
    const xSeconds = xSamples / sampleRate;

    const idx = i*4;
    output[idx] = xSeconds;
    output[idx + 1] = min;
    output[idx + 2] = xSeconds;
    output[idx + 3] = max;
  }

  let peak = 0;
  for(let i = 1; i < output.length; i += 2) peak = Math.max(peak, Math.abs(output[i]));
  for(let i = 1; i < output.length; i += 2) output[i] /= peak;
  
  return output;
}

function drawWaveform({tokens, pixelsPerSecond, scroll, width, height}: RenderMessageDraw): void {
  offscreen.width = width;
  offscreen.height = height;
  gl.viewport(0, 0, width, height);

  gl.clearColor(1.0, 1.0, 1.0, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  let timecode = -scroll;
  for(const token of tokens) {
    if(token.type === "PAUSE") {
      timecode += token.duration;

    } else {
      drawSection(timecode, token.start, token.duration, pixelsPerSecond);
      timecode += token.duration;
    }
  }
}

function drawSection(drawAtTime: number, tokenOffset: number, tokenDuration: number, pixelsPerSecond: number) {
  const lineCount = vertices.length / 4;
  const sampleCount = lineCount * renderPixelSize;
  const totalDuration = sampleCount / sampleRate;

  const pixelsPerClip = offscreen.width / 2;
  const totalClip = lineCount / pixelsPerClip;
  const secondsToClipScale = totalClip / totalDuration;

  const basePPS = sampleRate / renderPixelSize;
  const displayScale = pixelsPerSecond / basePPS;

  const scale = secondsToClipScale * displayScale;

  const scaleLoc = gl.getUniformLocation(program, "u_scale");
  gl.uniform4fv(scaleLoc, [scale, 1, 1, 1]);

  const startLine = Math.round(tokenOffset * sampleRate / renderPixelSize);
  
  const naturalTime = vertices[startLine * 4];
  const offset = drawAtTime - naturalTime;

  const offsetLoc = gl.getUniformLocation(program, "u_offset");
  gl.uniform4fv(offsetLoc, [offset, 0, 0, 0]);
  
  const vertexCount = Math.round(tokenDuration * sampleRate / renderPixelSize) * 2;
  gl.drawArrays(gl.LINES, startLine * 2, vertexCount);
}

const vsSource = `
  uniform vec4 u_offset;
  uniform vec4 u_scale;
  attribute vec4 a_Position;
  void main() {
    gl_Position = u_scale * (a_Position + u_offset) - vec4(1, 0, 0, 0);
  }
`;

const fsSource = `
  void main() {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  }
`;

function init(gl: WebGL2RenderingContext) {
  program = initShaders(gl, vsSource, fsSource);
  initVertexBuffers(gl, program);
  gl.useProgram(program);
}

function initShaders(gl: WebGL2RenderingContext, vs_source: string, fs_source: string): WebGLProgram {
  const vertexShader = makeShader(gl, vs_source, gl.VERTEX_SHADER);
  const fragmentShader = makeShader(gl, fs_source, gl.FRAGMENT_SHADER);

  const glProgram = gl.createProgram();
  if(!glProgram) throw new Error("Failed to create program");

  gl.attachShader(glProgram, vertexShader);
  gl.attachShader(glProgram, fragmentShader);
  gl.linkProgram(glProgram);

  if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
    alert('Unable to initialize the shader program: ' + gl.getProgramInfoLog(glProgram));
    throw new Error("Failed to create program");
  }

  return glProgram;
}

function initVertexBuffers(gl: WebGL2RenderingContext, program: WebGLProgram) {
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);

    const a_Position = gl.getAttribLocation(program, 'a_Position');
    gl.vertexAttribPointer(a_Position, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(a_Position);
}

function makeShader(gl: WebGL2RenderingContext, src: string, type: number) {
    const shader = gl.createShader(type);
    if(!shader) throw new Error("Failed to create shader");
    gl.shaderSource(shader, src);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      alert('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      throw new Error("Failed to create shader");
    }

    return shader;
}