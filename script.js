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
    animationRule: "decelerate",
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
    valueInt: 1,
    valueDec: 1,
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

startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.innerText = 'TESTING...';

    // Reset values
    pingVal.innerText = '-';
    downloadVal.innerText = '-';
    uploadVal.innerText = '-';
    gauge.update({ maxValue: 100 });
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

            if (speedMbps > gauge.options.maxValue) {
                gauge.update({ maxValue: Math.ceil(speedMbps / 100) * 100 });
            }
            gauge.value = speedMbps;
        }
    }

    downloadCard.classList.remove('testing');
}

// Implement Upload Test
async function runUploadTest() {
    return new Promise((resolve, reject) => {
        uploadCard.classList.add('testing', 'active');
        // 10MB of dummy data
        const data = new Uint8Array(10 * 1024 * 1024);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 255;

        const startTime = performance.now();
        const xhr = new XMLHttpRequest();

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const currentTime = performance.now();
                const duration = (currentTime - startTime) / 1000;
                if (duration > 0) {
                    const speedMbps = ((e.loaded * 8) / duration) / 1000000;
                    uploadVal.innerText = speedMbps.toFixed(1);

                    if (speedMbps > gauge.options.maxValue) {
                        gauge.update({ maxValue: Math.ceil(speedMbps / 100) * 100 });
                    }
                    gauge.value = speedMbps;
                }
            }
        };

        xhr.onload = () => {
            const endTime = performance.now();
            const duration = (endTime - startTime) / 1000;
            const finalMbps = ((data.length * 8) / duration) / 1000000;
            uploadVal.innerText = finalMbps.toFixed(1);
            gauge.value = finalMbps;
            uploadCard.classList.remove('testing');
            resolve();
        };

        xhr.onerror = () => {
            uploadCard.classList.remove('testing');
            reject(new Error('Upload failed'));
        };

        xhr.open('POST', ENDPOINT_UP);
        xhr.send(data);
    });
}
