// Initialize the speedometer gauge
const gauge = new RadialGauge({
    renderTo: 'speedometer',
    width: 300,
    height: 300,
    units: "Mbps",
    minValue: 0,
    maxValue: 100,
    majorTicks: ["0", "10", "20", "30", "40", "50", "60", "70", "80", "90", "100"],
    minorTicks: 2,
    strokeTicks: true,
    highlights: [
        { from: 0, to: 100, color: "rgba(255, 59, 59, 0.05)" }
    ],
    colorPlate: "#0b0b0b",
    borderShadowWidth: 0,
    borders: false,
    needleType: "arrow",
    needleWidth: 3,
    needleCircleSize: 7,
    needleCircleOuter: true,
    needleCircleInner: false,
    animationDuration: 500,
    animationRule: "linear",
    colorNeedle: "#ff3b3b",
    colorNeedleEnd: "#ff3b3b",
    colorMajorTicks: "#eee",
    colorMinorTicks: "#444",
    colorNumbers: "#eee",
    colorUnits: "#aaa",
    colorValueText: "#fff",
    colorValueBoxRect: "#1a1a1a",
    colorValueBoxRectEnd: "#1a1a1a",
    colorValueBoxBackground: "#1a1a1a",
    fontValueSize: 45,
    highlightsWidth: 10
}).draw();

// Update gauge size on window resize
function updateGaugeSize() {
    const width = Math.min(window.innerWidth - 40, 350);
    gauge.update({ width: width, height: width });
}

window.addEventListener('resize', updateGaugeSize);
updateGaugeSize();

// UI Elements
const startBtn = document.getElementById('start-btn');
const pingVal = document.getElementById('ping');
const downloadVal = document.getElementById('download');
const uploadVal = document.getElementById('upload');
const pingCard = document.getElementById('ping-card');
const downloadCard = document.getElementById('download-card');
const uploadCard = document.getElementById('upload-card');

// Endpoints
const ENDPOINT_DOWN = 'https://speed.cloudflare.com/__down';
const ENDPOINT_UP = 'https://speed.cloudflare.com/__up';

let currentMax = 100;
function updateGauge(value) {
    if (value > currentMax) {
        currentMax = Math.ceil(value / 100) * 100;
        const ticks = [];
        for (let i = 0; i <= 10; i++) {
            ticks.push((currentMax / 10 * i).toString());
        }
        gauge.update({
            maxValue: currentMax,
            majorTicks: ticks
        });
    }
    gauge.value = value;
}

startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.innerText = 'TESTING...';

    // Reset values
    pingVal.innerText = '-';
    downloadVal.innerText = '-';
    uploadVal.innerText = '-';
    currentMax = 100;
    gauge.update({
        maxValue: 100,
        majorTicks: ["0", "10", "20", "30", "40", "50", "60", "70", "80", "90", "100"]
    });
    [pingCard, downloadCard, uploadCard].forEach(c => {
        c.classList.remove('active', 'testing');
    });

    try {
        await runPingTest();
        await runDownloadTest();
        await runUploadTest();
    } catch (error) {
        console.error('Speed test failed:', error);
        alert('An error occurred during the test. Please try again.');
    } finally {
        startBtn.disabled = false;
        startBtn.innerText = 'START TEST';
        gauge.value = 0;
    }
});

// Implement Ping Test
async function runPingTest() {
    pingCard.classList.add('testing', 'active');
    const pings = [];

    for (let i = 0; i < 5; i++) {
        const start = performance.now();
        try {
            await fetch(`${ENDPOINT_DOWN}?bytes=0`, { cache: 'no-store' });
            const end = performance.now();
            pings.push(end - start);
            pingVal.innerText = Math.round(Math.min(...pings));
        } catch (e) {
            console.warn('Ping attempt failed', e);
        }
        await new Promise(r => setTimeout(r, 100));
    }

    const finalPing = pings.length > 0 ? Math.round(Math.min(...pings)) : 'Error';
    pingVal.innerText = finalPing;
    pingCard.classList.remove('testing');
    return finalPing;
}

// Implement Download Test
async function runDownloadTest() {
    downloadCard.classList.add('testing', 'active');
    const startTime = performance.now();
    const response = await fetch(`${ENDPOINT_DOWN}?bytes=25000000`, { cache: 'no-store' });
    const reader = response.body.getReader();
    let receivedLength = 0;

    while(true) {
        const {done, value} = await reader.read();
        if (done) break;

        receivedLength += value.length;
        const currentTime = performance.now();
        const duration = (currentTime - startTime) / 1000;

        if (duration > 0) {
            const bitsLoaded = receivedLength * 8;
            const speedMbps = (bitsLoaded / duration) / 1000000;
            downloadVal.innerText = speedMbps.toFixed(1);

            updateGauge(speedMbps);
        }
    }

    downloadCard.classList.remove('testing');
}

// Implement Upload Test using multiple fetch requests to avoid CORS preflight while tracking progress
async function runUploadTest() {
    uploadCard.classList.add('testing', 'active');

    const chunkSize = 1024 * 1024; // 1MB chunks
    const chunkData = "x".repeat(chunkSize);
    const numChunks = 10; // Increased for better measurement
    let totalBytesSent = 0;
    const startTime = performance.now();

    for (let i = 0; i < numChunks; i++) {
        try {
            await fetch(ENDPOINT_UP, {
                method: 'POST',
                body: chunkData,
                mode: 'cors'
            });

            totalBytesSent += chunkSize;
            const currentTime = performance.now();
            const duration = (currentTime - startTime) / 1000;

            if (duration > 0) {
                const speedMbps = ((totalBytesSent * 8) / duration) / 1000000;
                uploadVal.innerText = speedMbps.toFixed(1);

                updateGauge(speedMbps);
            }
        } catch (error) {
            console.error('Upload chunk failed:', error);
            uploadCard.classList.remove('testing');
            throw error;
        }
    }

    uploadCard.classList.remove('testing');
}
