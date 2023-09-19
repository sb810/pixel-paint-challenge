const express = require('express');
// noinspection NodeCoreCodingAssistance
const path = require('path');
const app = express();
const { WebSocketServer } = require('ws');

app.use(express.static(path.join(__dirname, 'build')));

app.get('/ping', function(req, res) {
  return res.send('pong');
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.listen(process.env.PORT || 8080);

const wsServer = new WebSocketServer({ port: 4040 });
const pingIntervalMS = 10000; // Ping all clients every 10 seconds.
const pingTimeoutMS = 1000; // How long to wait after a ping before considering a client unresponsive.
let userList = []; // Array of all connected users, represented by [UUID, color]
let tempUserList = []; // Temporary user list, switches with the active user list when it becomes stale.
let canvasState = []; // The complete history of all paint instructions sent.

/**
 * Shorthand method for sorting users based on their first array element (ID).
 * @param {[]} a - The first user
 * @param {[]} b - The second user
 * @returns {number} - The difference between the ID values of users 'a' and 'b'.
 */
const userSortFunc = (a,b) => a[0]-b[0]
let userListStale = false;

/**
 * Ping all connected users and add them to a temporary list.
 * After a delay, swap the potentially stale user list with the updated one.
 */
function sendKeepAlive() {
  userListStale = true;
  broadcast('ping');
  tempUserList = [];
  setTimeout(() => {
    userList = tempUserList.sort(userSortFunc);
    broadcast('announceConnectedUsers',userList.join(';'));
    userListStale = false;
    console.log("User list flushed. New list : " + userList.toString());
  }, pingTimeoutMS);
}

setInterval(sendKeepAlive, pingIntervalMS);

/**
 * Register a new client in the list of connected users.
 * @returns {number} - The new user's generated UUID.
 */
function addUser() {
  let newUUID = generateUUID()
  let newUser = [newUUID, "black"];
  userList.push(newUser);
  tempUserList.push(newUser); // Set a copy aside, in case a keepAlive was requested
  userList.sort(userSortFunc);
  console.log("Adding user [" + newUser.toString() + "] ...");
  return newUUID;
}

/**
 * Obviously, this isn't a real UUID generator, but it'll guarantee a unique value without anything fancy.
 * @returns {number} - The new generated UUID.
 */
function generateUUID() {
  let uuid = 0;
  let found = true;
  while(found) {
    uuid++;
    found = false;
    for(let user of userList)
      if (parseInt(user[0]) === uuid) found = true;
  }
  return uuid;
}

/**
 * Shorthand function to send a message to all connected clients.
 * @param {string} type - The message type.
 * @param {any} [data] - The JSON data to include.
 */
function broadcast(type, data) {
  for (const client of wsServer.clients) {
    client.send(data ?
      JSON.stringify({
        messageType: type,
        data: data
      }) : JSON.stringify({
        messageType: type
      })
    );
  }
}

wsServer.on('connection', (ws) => {
  console.log('WS client connected.');

  ws.send(JSON.stringify({
    messageType: 'announceUUID',
    data: addUser()
  }));

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());

    let validMessage = true;

    console.log('received message', message);
    switch (message.messageType) {

      case 'userAccepted' : // Client accepted their UUID, and is sending back their current color.
        let receivedData = message.data.split(',');
        let userRef = userList.find(user => parseInt(receivedData[0]) === user[0]);
        if (userRef) userRef[1] = receivedData[1];
        else {
          validMessage = false;
          break;
        }

        if(!userListStale) // Don't send a stale list to new users
          broadcast('announceConnectedUsers',userList.join(';'));

        if(canvasState.length > 0)
          ws.send(JSON.stringify({ // Send the complete canvas paint history to reconstruct it on the client.
            messageType: 'paint',
            data: canvasState.join(';')
          }));
        break;

      case 'pong': // After a ping, the client answers with its user identity [ID,color].
        let user = message.data.split(",");
        if(parseInt(user[0]) === -1){
          user[0] = addUser();
          ws.send(JSON.stringify({
            messageType: 'announceUUID',
            data: user[0]
          }));
        }
        tempUserList.push(user);
        break;

      /* Store the paint instruction in the canvas state history, then broadcast it to all clients.
       * For small apps or for a large canvas, storing direct paint instructions should work fine.
       * For larger apps, however, keeping track server-side of each individual pixel will be more efficient in the long run.
       * Server-side throttling could be implemented here by accumulating instructions and broadcasting them all at once. */
      case 'paint':
        for (let data of message.data.split(';')) {
          if (data.split(',').length === 3) {
            canvasState.push(data);
          } else {
            validMessage = false;
            break;
          }
        }
        if(validMessage)
          broadcast('paint', message.data);
        break;

      case 'updateColor': // The client broadcasts its identity [ID,color] to get the color updated elsewhere
        let data = message.data.split(',');
        if(data.length === 2) {
          if(userListStale) { // Actually, never send a stale list to clients
            tempUserList.find(u => parseInt(data[0]) === parseInt(u[0]))[1] = data[1];
          } else {
            userList.find(u => parseInt(data[0]) === parseInt(u[0]))[1] = data[1];
            broadcast('announceConnectedUsers',userList.join(';'));
          }
        } else validMessage = false;
        break;
    }

    if (!validMessage) { // Any failed websocket operation should be caught here and broadcast to the client at fault.
      ws.send(
        JSON.stringify({
          messageType: 'error',
          data: 'Client sent an unrecognized message format',
          originalMessage: message
        })
      );
    }
  });

  ws.on('close', () => {
    console.log('WS client disconnected.');
    sendKeepAlive(); // Since we don't know who disconnected, flush the list of connected users and query them all to rebuild it.
  });

  ws.onerror = console.error;
});
