import { kmeans } from 'ml-kmeans';

const video = document.getElementById('video')! as HTMLVideoElement;
const counter = document.getElementById('counter')!;
const uniqueColors = new Set<number>();

const videoCanvas = document.createElement('canvas');
const videoCanvasContext = videoCanvas.getContext('2d')!;

const webgpuCanvas = document.getElementById('webgpu-canvas') as HTMLCanvasElement;
const webgpuCanvasContext = webgpuCanvas.getContext("webgpu")!;

let device: GPUDevice
let pipeline: GPURenderPipeline
let sampler: GPUSampler
let targetBuffer: GPUBuffer

let doExtract = true
const doRender = true

const width = 640;
const height = 480;

// Target colors array (size must match TARGET_COLORS_SIZE in shader)
let targetColors = new Float32Array([
    1.0, 0.0, 0.0, 0.0,  // Red (vec3 + padding)
    0.0, 1.0, 0.0, 0.0,  // Green
    0.0, 0.0, 1.0, 0.0,  // Blue
    1.0, 1.0, 0.0, 0.0,  // Yellow
    0.0, 1.0, 1.0, 0.0,  // Cyan
    1.0, 0.0, 1.0, 0.0,  // Magenta
    // Fill remaining slots (10 * 4) to make a total of 16 entries
    ...Array(10 * 4).fill(0.0),
]);

async function runKMeans() {
    const data = Array.from(uniqueColors).map(e => [(e >> 16) & 0xff, (e >> 8) & 0xff, (e >> 0) & 0xff])
    const result = kmeans(data, 16, {});

    targetColors = new Float32Array(result.centroids.map(([x, y, z]) => [x / 255, y / 255, z / 255, 0]).flat())

    targetBuffer.destroy()
    targetBuffer = device!.createBuffer({
        size: targetColors.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Float32Array(targetBuffer.getMappedRange()).set(targetColors);
    targetBuffer.unmap();

    console.log('Clusters:', result.clusters); // Cluster assignments for each point
    console.log('Centroids:', result.centroids.map(([x, y, z]) => `${x / 255}, ${y / 255}, ${z / 255}`)); // Cluster centroids
}

document.getElementById("kmeans-button")!.onclick = runKMeans

async function startCamera() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        const deviceId = videoDevices.at(-1)!.deviceId
        const constraints = deviceId ? { video: { deviceId: { exact: deviceId } } } : { video: true };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;

        const videoTrack = stream.getVideoTracks()[0];
        const capabilities = videoTrack.getCapabilities();

        console.log("Camera capabilities:", capabilities);
    } catch (error) {
        console.error('Error accessing the camera:', error);
    }
}

function extractColors(data: Uint8ClampedArray) {

    // Iterate over pixels and collect unique RGB colors
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // Convert to a string format: "r,g,b"
        const rgb = (r << 16) + (g << 8) + b;
        uniqueColors.add(rgb);
    }

    // Update the UI
    counter.textContent = `Unique Colors: ${uniqueColors.size}`;
}

async function initWebGPU(canvas: HTMLCanvasElement): Promise<void> {
    // Check for WebGPU support
    if (!navigator.gpu) {
        throw new Error("WebGPU not supported");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error("Failed to get GPU adapter");
    }

    device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu")!;

    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device,
        format: canvasFormat,
        alphaMode: "opaque",
    });

    const shaderCode = `
    // Vertex Shader
    @vertex
    fn vertex_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
        var pos = array<vec4<f32>, 3>(
            vec4<f32>(-1.0, -1.0, 0.0, 1.0),
            vec4<f32>( 3.0, -1.0, 0.0, 1.0),
            vec4<f32>(-1.0,  3.0, 0.0, 1.0)
        );
        return pos[vertexIndex];
    }

    // Fragment Shader
    const TARGET_COLORS_SIZE: u32 = 16; // Define the number of target colors
    @group(0) @binding(0) var inputTexture: texture_2d<f32>;
    @group(0) @binding(1) var cameraImage: sampler;
    @group(0) @binding(2) var<uniform> targetColors: array<vec3<f32>, TARGET_COLORS_SIZE>;

    @fragment
    fn fragment_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
        let uv = fragCoord.xy / vec2<f32>(${width}.0, ${height}.0);
        let color = textureSample(inputTexture, cameraImage, uv);

        var matched = false;
        for (var i = 0u; i < TARGET_COLORS_SIZE; i++) {
            if (distance(color.rgb, targetColors[i]) < 0.1) {
                matched = true;
                break;
            }
        }

        if (matched) {
            return vec4<f32>(0.5, 0.0, 0.5, color.a);
        } else {
            return color;
        }
    }
`;

    const shaderModule = device.createShaderModule({ code: shaderCode });

    pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: {
            module: shaderModule,
            entryPoint: "vertex_main", // Use the new vertex shader entry point
        },
        fragment: {
            module: shaderModule,
            entryPoint: "fragment_main", // Use the new fragment shader entry point
            targets: [{ format: canvasFormat }],
        },
        primitive: {
            topology: "triangle-list",
        },
    });

    sampler = device!.createSampler({ magFilter: "linear", minFilter: "linear" });

    targetBuffer = device!.createBuffer({
        size: targetColors.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Float32Array(targetBuffer.getMappedRange()).set(targetColors);
    targetBuffer.unmap();
}

function renderGreenScreen(frameBitmap: ImageBitmap) {
    // Upload video frame to a GPU texture
    const videoTexture = device.createTexture({
        size: [video.videoWidth, video.videoHeight],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.copyExternalImageToTexture(
        { source: frameBitmap },
        { texture: videoTexture },
        [video.videoWidth, video.videoHeight]
    );

    // Bindings
    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: videoTexture.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: targetBuffer } },
        ],
    });

    // Render pass
    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [
            {
                view: webgpuCanvasContext.getCurrentTexture().createView(),
                loadOp: "clear",
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                storeOp: "store",
            },
        ],
    });

    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(6); // Fullscreen quad
    passEncoder.end();

    device.queue.submit([commandEncoder.finish()]);
}

async function renderLoop() {
    if (video.videoWidth == 0) {
        requestAnimationFrame(renderLoop);
        return
    }

    if (video.videoWidth != width || video.videoHeight != height) {
        console.log("Error")
    }

    if (doExtract) {
        videoCanvas.width = video.videoWidth;
        videoCanvas.height = video.videoHeight;
        videoCanvasContext.drawImage(video, 0, 0, videoCanvas.width, videoCanvas.height);
        const { data } = videoCanvasContext.getImageData(0, 0, videoCanvas.width, videoCanvas.height);

        extractColors(data)
    }

    if (doRender) {
        webgpuCanvas.width = video.videoWidth;
        webgpuCanvas.height = video.videoHeight;

        const frameBitmap = await createImageBitmap(video)
        renderGreenScreen(frameBitmap)
    }

    requestAnimationFrame(renderLoop);
}

document.getElementById("calibrate-cb")!.onclick = (e) => {
    doExtract = !doExtract
}


// Main entry point
(async () => {
    const canvas = document.getElementById("webgpu-canvas") as HTMLCanvasElement;

    await startCamera();
    await initWebGPU(canvas);

    renderLoop()
})();