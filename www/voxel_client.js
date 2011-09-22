var VoxelClient = { };

//How writing voxels works:
// Writes may be applied locally, but must be acked by the server before they persist.
//
// If a write is not acked, then after a certain amount of time it gets rolled back to the last
// known acked state.
//

(function() {

//Local variables
var cells = {},
    worker = null,
    voxel_set = null,
    emitter = new EventEmitter(),
    local_writes = {},
    local_write_interval = null;


//A local write (stored client side)
function LocalWrite(counter, prev) {
  this.counter  = counter;
  this.prev     = prev;
};

//Iterate on local writes, roll back any bad changes
function checkLocalWrites() {
  for(var id in local_writes) {
    var local = local_writes[id];
    
    if(--local.counter <= 0) {
      var k = parseInt(id),
          x = Voxels.unhash(k),
          y = Voxels.unhash(k>>1),
          z = Voxels.unhash(k>>2);
      voxel_set.set(x, y, z, local.prev);
      post('setVoxel', x, y, z, local.prev);
      delete local_writes[id];
    }
  }
};

//Posts a message to the worker
function post() {
  worker.postMessage(Array.prototype.slice.call(arguments));
} 

//Special case for handling console.log
emitter.on('log', function() {
  console.log.apply(console, ['VoxelWorker:'].concat(Array.prototype.slice.call(arguments)));
}); 

//Update a cell
emitter.on('updateCell', function(coord, vertices) {
  var key = Voxels.hashChunk(coord[0], coord[1], coord[2]);
  if(key in cells) {
    cells[key].update(vertices);
  }
  else {
    cells[key] = Render.createVoxelCell(coord[0], coord[1], coord[2], vertices);
  }
});

//Removes a cell from the data set
emitter.on('removeCell', function(coord) {
  var key = Voxels.hashChunk(coord[0], coord[1], coord[2]);
  if(key in cells) {
    cells[key].release();
    delete cells[key];
  }
});

VoxelClient.init = function(cb) {

  if(!window.Worker) {
    cb("Client does not support web workers");
    return;
  }
  
  console.log("Starting voxel worker");

  //Clear out local data
  cells = {};
  
  //Allocate initial voxel set
  voxel_set = new Voxels.ChunkSet();

  //Set up local write interval polling
  local_writes = {};
  local_write_interval = setInterval(checkLocalWrites, 250);

  //Start the web worker
  worker = new Worker("/cell_worker.js");
  worker.onmessage = function(event) {
    emitter.emit.apply(emitter, event.data);
  };
  
  //Handle error condition from worker by crashing app
  worker.onerror = function(error) {
    worker.terminate();
    if(typeof(error) == "object" && "message" in error) {
      App.crash("VoxelWorker crashed: (" + error.filename + ":" + error.lineno + ") -- " + error.message );
    }
    else {
      App.crash("VoxelWorker crashed: " + JSON.stringify(error));
    }
  };
  
  //Wait for worker to start
  emitter.once('started', function() {
    cb(null);
  });
  
  
  post('start');
};

//Stops the voxel client/worker
VoxelClient.deinit = function(cb) {
  voxel_set = null;
  emitter.once('stopped', function() {
    cb(null);
  });
  post('stop');
  buffered_updates = [];
  
  //Stop polling for updates
  if(local_write_interval) {
    clearInterval(local_write_interval);
    local_write_interval = null;
  }
};

//Draws all the voxels
VoxelClient.draw = function() {
  for(var id in cells) {
    cells[id].draw();
  }
};

//Called when a voxel gets updated locally
VoxelClient.setVoxel = function(x, y, z, v) {
  var p = voxel_set.set(x,y,z,v);
  if(p !== v) {
  
    //Mark local write in case it must be rolled back later
    var key   = voxels.hashChunk(x,y,z),
        local = local_writes[key];
    if(local && local.prev === v) {
      delete local_writes[key];
    }
    else {
      local_writes[key] = new LocalWrite(5, p);
    }
    
    post('setVoxel', x, y, z, v);
  }
  return p;
};

//Called when a server confirms that a voxel has been set
VoxelClient.setVoxelAuthoritative = function(x, y, z, v) {

  //Remove local writes
  var key = Voxels.hashChunk(x,y,z);
  if(key in local_writes) {
    delete local_writes[key];
  }
  
  //Check if there was a correction
  if(voxel_set.set(x,y,z,v) !== v) {
    post('setVoxel', x, y, z, v);
  }
};



//Called when a chunk gets updated
VoxelClient.updateChunk = function(cx, cy, cz, data) {
  voxel_set.setChunk(cx,cy,cz,data);
  post('updateChunk', cx, cy, cz, data);
};

//Called when a chunk is removed
VoxelClient.removeChunk = function(cx, cy, cz) {
  voxel_set.removeChunk(cx, cy, cz);
  post('removeChunk', cx, cy, cz);
};

})();