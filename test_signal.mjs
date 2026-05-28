import WebSocket from 'ws';

const ws1 = new WebSocket('ws://127.0.0.1:8080');
const ws2 = new WebSocket('ws://127.0.0.1:8080');

ws1.on('open', () => {
  console.log('ws1 connected');
  ws1.send(JSON.stringify({ type: 'register', peerId: 'p1', displayName: 'Peer1', deviceName: 'D1' }));
});

ws2.on('open', () => {
  console.log('ws2 connected');
  ws2.send(JSON.stringify({ type: 'register', peerId: 'p2', displayName: 'Peer2', deviceName: 'D2' }));
});

ws1.on('message', (data) => {
  console.log('ws1 received:', data.toString());
});

ws2.on('message', (data) => {
  console.log('ws2 received:', data.toString());
  const msg = JSON.parse(data.toString());
  if (msg.type === 'peer-joined' && msg.peer.peerId === 'p1') {
    // wait a moment then request
  }
});

setTimeout(() => {
  console.log('ws1 requesting connect to p2');
  ws1.send(JSON.stringify({ type: 'connect-request', to: 'p2' }));
}, 1000);

setTimeout(() => {
  console.log('Done.');
  ws1.close();
  ws2.close();
  process.exit(0);
}, 2000);
