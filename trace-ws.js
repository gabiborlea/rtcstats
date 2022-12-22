/* eslint-disable prefer-rest-params */
import { v4 as uuidv4 } from 'uuid';

import { PROTOCOL_ITERATION, MAX_RECONNECT_ATTEMPTS, messageTypes, CONFERENCE_LEAVE_CODE } from './constants';
import obfuscator from './obfuscator';

/**
 *
 * @param {*} reconnectAttempts
 * @returns
 */
function getTimeout(reconnectAttempts) {
    return ((2 ** reconnectAttempts) * 1000) + Math.floor(Math.random() * 1000);
}

/**
 *
 * @param {*} endpoint
 * @param {*} onCloseCallback
 * @param {*} pingInterval
 */
export default function({ endpoint, meetingFqn, onCloseCallback, useLegacy, obfuscate = true, pingInterval = 30000 }) {
    // Parent stats session id, used when breakout rooms occur to keep track of the initial stats session id.
    let parentStatsSessionId;

    // Buffer for storing stats if there is no connection to the server.
    let buffer = [];
    let statsSessionId = uuidv4();
    let connection;
    let keepAliveInterval;
    let reconnectAttempts = 0;

    // The index of the last stats that the server received.
    let sequenceNumber = 1;
    let reconnectTimeout;

    // We maintain support for legacy chrome rtcstats just in case we need some critical statistic
    // only obtainable from that format, ideally we'd remove this in the future.
    const protocolVersion = useLegacy ? `${PROTOCOL_ITERATION}_LEGACY` : `${PROTOCOL_ITERATION}_STANDARD`;

    const trace = function(msg) {
        if (connection && (connection.readyState === WebSocket.OPEN)) {
            connection.send(JSON.stringify(msg));
        }
        buffer.push(msg);
    };

    trace.identity = function(...data) {
        data.push(new Date().getTime());
        data.push(sequenceNumber++);

        if (parentStatsSessionId) {
            data[2].parentStatsSessionId = parentStatsSessionId;
        }

        const identityMsg = {
            statsSessionId,
            type: 'identity',
            data
        };

        trace(identityMsg);
    };

    trace.statsEntry = function(...data) {

        let myData = data;

        if (obfuscate) {
            switch (data[0]) {
            case 'addIceCandidate':
            case 'onicecandidate':
            case 'setLocalDescription':
            case 'setRemoteDescription':
                // These functions need to original values to work with
                // so we need a deep copy to do the obfuscation on.
                myData = JSON.parse(JSON.stringify(myData));
                break;
            default:
                break;
            }

            // Obfuscate the ips is required.
            obfuscator(myData);
        }

        myData.push(new Date().getTime());
        myData.push(sequenceNumber++);

        const statsEntryMsg = {
            statsSessionId,
            type: 'stats-entry',
            data: JSON.stringify(myData)
        };

        trace(statsEntryMsg);
    };

    trace.keepAlive = function() {

        const keepaliveMsg = {
            statsSessionId,
            type: 'keepalive'
        };

        trace(keepaliveMsg);
    };

    trace.close = function() {
        connection && connection.close(CONFERENCE_LEAVE_CODE);
    };

    trace.connect = function(isBreakoutRoom) {
        if (isBreakoutRoom && !parentStatsSessionId) {
            parentStatsSessionId = statsSessionId;
        }
        if (parentStatsSessionId) {
            statsSessionId = uuidv4();
            buffer.forEach(entry => {
                entry.statsSessionId = statsSessionId;
            });
        }
        if (connection) {
            connection.close();
        }

        connection = new WebSocket(
            `${endpoint}/${meetingFqn}?statsSessionId=${statsSessionId}`,
            protocolVersion,
            { headers: { 'User-Agent': navigator.userAgent } }
        );

        connection.onclose = function(closeEvent) {
            keepAliveInterval && clearInterval(keepAliveInterval);

            onCloseCallback({ code: closeEvent.code,
                reason: closeEvent.reason });

            // Do not try to reconnect if connection was closed intentionally.
            if (closeEvent.code === CONFERENCE_LEAVE_CODE) {
                return;
            }
            reconnectTimeout = setTimeout(() => {
                reconnectAttempts++;

                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    trace.connect(isBreakoutRoom);
                }
            }, getTimeout(reconnectAttempts));
        };

        connection.onopen = function() {
            keepAliveInterval = setInterval(trace.keepAlive, pingInterval);
            reconnectTimeout && clearTimeout(reconnectTimeout);
            reconnectAttempts = 0;

            buffer.forEach(entry => connection.send(JSON.stringify(entry)));
        };

        connection.onmessage = function(msg) {
            const { type, body } = JSON.parse(msg.data);

            if (type === messageTypes.SequenceNumber && body && typeof body === 'number') {
                buffer = buffer.filter(entry => {
                    const { data } = entry;
                    const jsonData = Array.isArray(data) ? data : JSON.parse(data);

                    if (jsonData[4] > body) {
                        return true;
                    }

                    return false;
                });
            }
        };
    };

    return trace;
}
