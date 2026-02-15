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
    animationDuration: 100, // Reduced to be more responsive
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
    highlightsWidth: 10,
    valueInt: 1,
    valueDec: 1
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
            majorTicks: ticks,
            highlights: [{ from: 0, to: currentMax, color: "rgba(255, 59, 59, 0.05)" }]
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
        majorTicks: ["0", "10", "20", "30", "40", "50", "60", "70", "80", "90", "100"],
        highlights: [{ from: 0, to: 100, color: "rgba(255, 59, 59, 0.05)" }]
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

// Improved Speed measurement with throttling and sliding window
async function runDownloadTest() {
    downloadCard.classList.add('testing', 'active');
    const startTime = performance.now();
    const response = await fetch(`${ENDPOINT_DOWN}?bytes=50000000`, { cache: 'no-store' }); // Increased to 50MB
    const reader = response.body.getReader();
    let receivedLength = 0;
    let lastUpdate = performance.now();

    // Sliding window for instantaneous speed
    const windowSize = 500; // ms
    const samples = [];

    while(true) {
        const {done, value} = await reader.read();
        if (done) break;

        const now = performance.now();
        receivedLength += value.length;
        samples.push({ t: now, bytes: value.length });

        // Cleanup old samples
        while(samples.length > 0 && now - samples[0].t > windowSize) {
            samples.shift();
        }

        // Update UI every 100ms
        if (now - lastUpdate > 100) {
            const duration = (now - startTime) / 1000;
            const avgSpeedMbps = ((receivedLength * 8) / duration) / 1000000;

            // Instantaneous speed
            const windowBytes = samples.reduce((acc, s) => acc + s.bytes, 0);
            const windowDuration = samples.length > 1 ? (now - samples[0].t) / 1000 : 0.1;
            const instSpeedMbps = ((windowBytes * 8) / windowDuration) / 1000000;

            downloadVal.innerText = avgSpeedMbps.toFixed(1);
            updateGauge(instSpeedMbps);
            lastUpdate = now;
        }
    }

    // Final update
    const finalDuration = (performance.now() - startTime) / 1000;
    const finalSpeedMbps = ((receivedLength * 8) / finalDuration) / 1000000;
    downloadVal.innerText = finalSpeedMbps.toFixed(1);
    updateGauge(finalSpeedMbps);

    downloadCard.classList.remove('testing');
}

async function runUploadTest() {
    uploadCard.classList.add('testing', 'active');

    const chunkSize = 1024 * 1024; // 1MB chunks
    const chunkData = "x".repeat(chunkSize);
    const testDuration = 10000; // 10 seconds max
    const startTime = performance.now();
    let totalBytesSent = 0;
    let lastUpdate = performance.now();

    const samples = [];

    while (performance.now() - startTime < testDuration) {
        try {
            const chunkStart = performance.now();
            await fetch(ENDPOINT_UP, {
                method: 'POST',
                body: chunkData,
                mode: 'cors'
            });
            const chunkEnd = performance.now();

            totalBytesSent += chunkSize;
            const now = performance.now();
            samples.push({ t: now, bytes: chunkSize });

            while(samples.length > 0 && now - samples[0].t > 1000) {
                samples.shift();
            }

            if (now - lastUpdate > 100) {
                const totalDuration = (now - startTime) / 1000;
                const avgSpeedMbps = ((totalBytesSent * 8) / totalDuration) / 1000000;

                const windowBytes = samples.reduce((acc, s) => acc + s.bytes, 0);
                const windowDuration = samples.length > 1 ? (now - samples[0].t) / 1000 : (chunkEnd - chunkStart) / 1000;
                const instSpeedMbps = ((windowBytes * 8) / windowDuration) / 1000000;

                uploadVal.innerText = avgSpeedMbps.toFixed(1);
                updateGauge(instSpeedMbps);
                lastUpdate = now;
            }
        } catch (error) {
            console.error('Upload chunk failed:', error);
            break;
        }
    }

    const finalDuration = (performance.now() - startTime) / 1000;
    const finalSpeedMbps = ((totalBytesSent * 8) / finalDuration) / 1000000;
    uploadVal.innerText = finalSpeedMbps.toFixed(1);
    updateGauge(finalSpeedMbps);

    uploadCard.classList.remove('testing');
}
