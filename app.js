const video = document.getElementById('video');
const counter = document.getElementById('counter');
const uniqueColors = new Set();

async function startCamera() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        const deviceId = videoDevices.at(-1).deviceId
        const constraints = deviceId ? { video: { deviceId: { exact: deviceId } } } : { video: true };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
    } catch (error) {
        console.error('Error accessing the camera:', error);
    }
}

function extractColors() {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Draw the video frame to the canvas
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Get image data from the canvas
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imageData;

    // Iterate over pixels and collect unique RGB colors
    for (let i = 0; i < data.length; i += 4) {
        const d = 3;
        const r = data[i] / d;
        const g = data[i + 1] / d;
        const b = data[i + 2] / d;

        // Convert to a string format: "r,g,b"
        const rgb = (r << 16) + (g << 8) + b;
        uniqueColors.add(rgb);
    }

    // Update the UI
    counter.textContent = `Unique Colors: ${uniqueColors.size}`;
}

// Start capturing unique colors at regular intervals
function startColorCapture() {
    setInterval(extractColors, 500); // Capture every 500ms
}

// Initialize the application
startCamera().then(startColorCapture);