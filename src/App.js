import React, { useEffect, useRef, useState } from 'react';
import { canvasSize } from './constants';
import './App.css';

function randomColor() {
  return `#${[0, 0, 0]
    .map(() => Math.floor(Math.random() * 256).toString(16))
    .join('')}`;
}

/**
 * Generate a new random color, or use the color cached in localStorage if it exists.
 * @returns {string} - the user's current color
 */
function randomOrCachedColor() {
  let col = localStorage.getItem('color');
  if (!col) {
    col = randomColor();
    localStorage.setItem('color', col);
  }
  return col;
}

let websocket;

function getWebSocket() {
  return (websocket =
    websocket || new WebSocket(`ws://${window.location.hostname}:4040`));
}

let clientPainting = false;
let currentUserId = -1;

/**
 * Shorthand function for filling a single pixel on a canvas with a color.
 * @param {CanvasRenderingContext2D} ctx - The canvas context
 * @param {number} x - The X coordinate of the pixel to fill, relative to the canvas' origin
 * @param {number} y - The Y coordinate of the pixel to fill, relative to the canvas' origin
 * @param {string} color - The fill color to use
 */
function paint(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
}

function App() {
  const canvasRef = useRef(null);
  const websocketRef = useRef(getWebSocket());
  const [color, setColor] = useState(() => randomOrCachedColor());
  const [foreignUserList, setForeignUserList] = useState(() => []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return; // should never happen

    const ctx = canvas.getContext('2d');
    const ws = websocketRef.current;

    let paintInstructionQueue = []; // Queuing multiple paint instructions is more efficient than sending them every update.

    /* Drawing directly on the canvas before sending the paint instruction to the server can be more user-friendly (especially with low-end connections),
    * but this allows all paint operations to go through the same queue before being drawn, ensuring that they are identical for everyone. */
    const sendPaintInstructionQueue = () => {
      if (paintInstructionQueue.length > 0) {
        ws.send(JSON.stringify({
          messageType: 'paint',
          data: paintInstructionQueue.join(';')
        }));
        paintInstructionQueue = [];
      }
    };

    setInterval(sendPaintInstructionQueue, 50); // A 50ms timeout seems appropriate for now, but this can be lowered with scale.

    const setClientPainting = () => {
      clientPainting = currentUserId !== -1; // Client should only be able to paint once a connection has been established.
      if (clientPainting)
        ws.send( // When client starts painting, broadcast its current color
          JSON.stringify({
            messageType: 'updateColor',
            data: currentUserId + ',' + color
          })
        );
    };

    const setClientNotPainting = () => clientPainting = false;
    const handleTouch = (touchEvent) => {
      if (clientPainting) {
        let x = Math.round(touchEvent.touches[0].clientX - canvas.getBoundingClientRect().left);
        let y = Math.round(touchEvent.touches[0].clientY - canvas.getBoundingClientRect().top);
        paintInstructionQueue.push([x,y,color]);
      }
    };

    const handleMouseMove = (mouseMoveEvent) => {
      if (clientPainting) {
        let x = Math.round(mouseMoveEvent.x - canvas.getBoundingClientRect().left);
        let y = Math.round(mouseMoveEvent.y - canvas.getBoundingClientRect().top)
        paintInstructionQueue.push([x,y,color]);
      }
    };

    // A paint operation should only be detected on the canvas.
    canvas.addEventListener('mousedown', setClientPainting);
    canvas.addEventListener('touchstart', setClientPainting);

    // The end of a paint operation can happen anywhere in the window.
    window.addEventListener('mouseup', setClientNotPainting);
    window.addEventListener('touchend', setClientNotPainting);

    // When moving, queue all paint instructions before sending them to the server.
    canvas.addEventListener('touchmove', handleTouch);
    canvas.addEventListener('mousemove', handleMouseMove);

    ws.onmessage = (e) => {
      const message = JSON.parse(e.data);
      switch (message.messageType) {

        case 'announceUUID': // Server assigns the client a new UUID, and expects an answer with the client identity [ID,color]
          currentUserId = message.data;
          ws.send( // broadcast the newly assigned UUID
            JSON.stringify({
              messageType: 'userAccepted',
              data: currentUserId + ',' + color
            })
          );
          break;

        case 'announceConnectedUsers': // Server is broadcasting the list of all active users.
          let userList = message.data.split(';');
          let tmpForeignUserList = [];
          for (let userData of userList) {
            let user = userData.split(',');
            if (parseInt(user[0]) !== currentUserId) tmpForeignUserList.push(user);
          }
          setForeignUserList(tmpForeignUserList);
          break;

        case 'paint': // Draw a pixel on the canvas for each paint instruction received.
          for (let data of message.data.split(';')) {
            let paintInstruction = data.split(',');
            let x = parseInt(paintInstruction[0]);
            let y = parseInt(paintInstruction[1]);
            let color = paintInstruction[2];
            if (paintInstruction.length === 3)
              paint(ctx, x, y, color); // We could check for garbage data here, but the overhead seems unnecessary.
            else {
              console.error("Invalid paint data received : " + data);
              break;
            }
          }
          break;

        case 'ping': // Server requests the user identity [ID,color]
          ws.send(
            JSON.stringify({
              messageType: 'pong',
              data: currentUserId + ',' + color
            })
          );
          break;

        case 'error':
          console.error(message);
          break;

        default:
          console.error('Unrecognized message format from server BANANA : ' + message.messageType);
      }
    };
    return () => {
      canvas.removeEventListener('mousedown', setClientPainting);
      canvas.removeEventListener('touchstart', setClientPainting);
      window.removeEventListener('mouseup', setClientNotPainting);
      window.removeEventListener('touchend', setClientNotPainting);
      canvas.removeEventListener('touchmove', handleTouch);
      canvas.removeEventListener('mousemove', handleMouseMove);

      clearInterval(sendPaintInstructionQueue);
      sendPaintInstructionQueue();
    };
  }, [color, foreignUserList]);

  return (
    <div className='app'>
      <header>
        <h1>Pixel paint</h1>
        <div className='color_selection'>
          Your color:{' '}
          <input
            type='color'
            value={color}
            onChange={(e) => {
              let col = e.target.value;
              setColor(col);
              localStorage.setItem('color', col);
            }}
          />
        </div>
      </header>
      <main className='main_content'>
        <div className='canvas_container'>
          <canvas
            style={{ overscrollBehavior: 'none' }}
            ref={canvasRef}
            width={canvasSize.width}
            height={canvasSize.height}
          />
        </div>
        <div>
          <h3 className='connected_users_title'>Connected users</h3>
          {currentUserId === -1 ?
            <img src='https://cdnjs.cloudflare.com/ajax/libs/galleriffic/2.0.1/css/loader.gif' alt='Loading...' />
            : <ConnectedUser key={currentUserId} color={color} id={currentUserId} />
          }
          {foreignUserList.map((user) => (
            <ConnectedUser key={user[0]} color={user[1]} id={user[0]} />
          ))}
        </div>
      </main>
    </div>
  );
}

function ConnectedUser({ color, id }) {
  return (
    <div className='connected_user'>
      <div className='user_color' style={{ '--user-color': color }} />
      <div>{`User ${id} ${id === currentUserId ? '(You)' : ''}`}</div>
    </div>
  );
}

export default App;
