module.exports = function(RED) {
    const HID = require('node-hid');

    // Surface Dial constants
    const VENDOR_ID = 0x045E;  // Microsoft
    const PRODUCT_ID = 0x091B; // Surface Dial
    const RECONNECT_POLL_INTERVAL = 50; // ms

    function SurfaceDialNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        let device = null;
        let pollTimer = null;
        let prevButtonState = false;
        let closing = false;

        // Attempt to find and open the Surface Dial
        // Returns the device handle or null if not found
        function connectDevice() {
            try {
                const devices = HID.devices(VENDOR_ID, PRODUCT_ID);
                if (devices.length === 0) {
                    return null;
                }

                const deviceInfo = devices[0];
                const dev = new HID.HID(deviceInfo.path);

                node.log(`Found Surface Dial: ${deviceInfo.product || 'Unknown'} at ${deviceInfo.path}`);
                return dev;
            } catch (err) {
                node.log(`Failed to connect: ${err.message}`);
                return null;
            }
        }

        // Parse HID report data
        function parseReport(data) {
            if (data.length < 4) {
                return;
            }

            // Check Report ID (must be 1)
            const reportID = data[0];
            if (reportID !== 1) {
                return;
            }

            // Parse button state (byte 1, bit 0)
            const buttonPressed = (data[1] & 0x01) !== 0;

            // Detect button state transitions
            if (buttonPressed !== prevButtonState) {
                const state = buttonPressed ? "pressed" : "released";
                node.send({
                    payload: state,
                    topic: "button"
                });
                prevButtonState = buttonPressed;
            }

            // Parse rotation value (bytes 2-3, little-endian signed int16)
            let rotation = data[2] | (data[3] << 8);
            // Convert to signed int16
            if (rotation > 32767) {
                rotation -= 65536;
            }

            if (rotation !== 0) {
                const direction = rotation > 0 ? "clockwise" : "counter-clockwise";
                node.send({
                    payload: direction,
                    topic: "rotation"
                });
            }
        }

        // Start listening for device events
        function startEventLoop() {
            if (!device || closing) {
                return;
            }

            device.on('data', (data) => {
                parseReport(data);
            });

            device.on('error', (err) => {
                if (closing) {
                    return;
                }
                node.log(`Device error: ${err.message}`);
                handleDisconnect();
            });
        }

        // Handle device disconnection
        function handleDisconnect() {
            if (closing) {
                return;
            }

            if (device) {
                try {
                    device.close();
                } catch (e) {
                    // Ignore close errors
                }
                device = null;
            }

            prevButtonState = false;
            node.status({ fill: "red", shape: "ring", text: "disconnected" });

            // Start polling for reconnection
            waitForDevice();
        }

        // Poll for device until available or node is closed
        function waitForDevice() {
            if (closing) {
                return;
            }

            // Try immediate connection first
            device = connectDevice();
            if (device) {
                node.status({ fill: "green", shape: "dot", text: "connected" });
                startEventLoop();
                return;
            }

            // Start polling
            node.status({ fill: "grey", shape: "ring", text: "waiting..." });

            pollTimer = setInterval(() => {
                if (closing) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                    return;
                }

                device = connectDevice();
                if (device) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                    node.status({ fill: "green", shape: "dot", text: "connected" });
                    startEventLoop();
                }
            }, RECONNECT_POLL_INTERVAL);
        }

        // Start connection loop on deploy
        waitForDevice();

        // Cleanup on node close
        node.on('close', (done) => {
            closing = true;

            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }

            if (device) {
                try {
                    device.close();
                } catch (e) {
                    // Ignore close errors
                }
                device = null;
            }

            done();
        });
    }

    RED.nodes.registerType("surface-dial", SurfaceDialNode);
};
