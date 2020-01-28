import channels from "./system-channels";




//establish comms with the background script 
let port = chrome.runtime.connect({name: "fdc3"});
//flag to indicate the background script is ready for fdc3!
let connected = false;
//queue of pending events - accumulate until the background is ready
const eventQ = [];


/**
 * return listeners
 * most fdc3 api calls are promise based and many require resolution/rejection following complex interaction that may involve end user input, app loading times etc
 * so, we need to a symetrical return event when events are dispatched to the background script and to uniquely identifiy the event
 * also, need to support timeout/expiration of the event, for example, if an app takes too long to load or an end user never responds to a prompt
 * 
 * all promise based FDC3 methods send an event to the background script and listens for an event of "return" + eventName 
 * a unique identifier is assigned to the event (timestamp) 
 * the return handler will route back to correct handler function via the timestamp identifier
 * handlers will be routinely cleaned up by finding all events that have expired (check timestamp) and rejecting those items
 */
//collection of listeners for api calls coming back from the background script
let returnListeners = {};
const returnTimeout = (1000 * 60 * 2);

 //listen for return messages for api calls
 port.onMessage.addListener(msg => {
    //is there a returnlistener registered for the event?
    let listener = returnListeners[msg.topic] ? returnListeners[msg.topic].listener : null;
    if (listener){
        console.log("Content: listener", msg);
        listener.call(port,msg);
        returnListeners[msg.name] = undefined;
    }
 });

 //automated handlers based on manifest metadata - other handlers are set and dispatched by the API layer
 //these just need to be markers - since the handling itself is just automgenerated from the metadata held in the manifest 
 let _intentHandlers = [];
 let _contextHandlers = [];
 let contentManifest = null;

 let currentChannel = null;

 //retrieve the document title for a tab
function getTabTitle(tabId){
    let id = tabId;
    return new Promise((resolve, reject) => {
        port.onMessage.addListener(msg => {
            if (msg.topic === "tabTitle" && id === msg.tabId){
                resolve(msg.data.title);
            }
        });
        port.postMessage({topic:"getTabTitle", "tabId":tabId});
    });  
}

const wireTopic = (topic, config) => {
    
    document.addEventListener(`FDC3:${topic}`,e => {
        let cb = config ? config.cb : null;
        let isVoid = config ? config.isVoid : null;

        //get eventId and timestamp from the event 
        if (! isVoid){
            console.log(`Content: wireTopic.  topic = '${topic}', event`,e);
            let eventId = e.detail.eventId;
            returnListeners[eventId] = {
                ts:e.ts,
                listener:function(msg, port){
                console.log(`Content: dispatch return event for ${eventId}`,e);    
                document.dispatchEvent(new CustomEvent(`FDC3:return_${eventId}`, {detail:msg.data})); }
            };
            if (cb){
                cb.call(this,e);
            }
        }
        //if  background script isn't ready yet, queue these messages...
        let msg = {"topic":topic, "data": e.detail};
        if (!connected){
            eventQ.push(msg);
        }
        else {
            port.postMessage(msg);   
        }
    }); 
    
};
 
 //listen for FDC3 events
 //boilerplate topics
 const topics = ["open","raiseIntent","addContextListener","addIntentListener"];
 topics.forEach(t => {wireTopic(t);});
 //set the custom ones...
 wireTopic("joinChannel",{cb:(e) => { currentChannel = e.detail.channel;}});
 wireTopic("broadcast",{isVoid:true});

document.addEventListener("FDC3:resolver-close", e => {
    console.log("close resolver");
    port.postMessage({topic:"resolver-close"});   
    if (resolver){
        resolver.style.display = "none";
    }
});

//systemchannels are constant and we don't have to go to the background script, so handle directly
document.addEventListener("FDC3:getSystemChannels", e => {
    document.dispatchEvent(new CustomEvent("FDC3:returnSystemChannels",{detail:{data:channels} } ));
});


document.addEventListener('FDC3:findIntent',e => {
// returns a single AppIntent:
// {
//     intent: { name: "StartChat", displayName: "Chat" },
//     apps: [{ name: "Skype" }, { name: "Symphony" }, { name: "Slack" }]
// }
    const intent = e.detail.intent;
    const context = e.detail.context;

    let r = {intent:{},
                apps:[]};
    port.onMessage.addListener(msg => {
        if (msg.topic === "returnFindIntent" && msg.intent === intent && msg.context === context){

            r.apps = msg.data;
            let intnt = r.apps[0].intents.filter(i => {return i.name === intent;});
            if (intnt.length > 0){
                r.intent.name = intnt[0].name;
                r.intent.displayName = intnt[0].display_name;
            }
            
            //set the intent metadata...
            document.dispatchEvent(new CustomEvent("FDC3:returnFindIntent", {detail:{data:r}})); 
                    
        }
    });
    //retrieve apps for the intent
    port.postMessage({topic:"findIntent", "intent":intent,"context":e.detail.context});
    
});


document.addEventListener('FDC3:findIntentsByContext',e => {
// returns, for example:
// [{
//     intent: { name: "StartCall", displayName: "Call" },
//     apps: [{ name: "Skype" }]
// },
// {
//     intent: { name: "StartChat", displayName: "Chat" },
//     apps: [{ name: "Skype" }, { name: "Symphony" }, { name: "Slack" }]
// }];
        const context = e.detail.context;
    
        //{intent:{},
                 //   apps:[]};
        port.onMessage.addListener(msg => {
            if (msg.topic === "returnFindIntentsByContext" && msg.context === context){
    
                let r = [];
                let d = msg.data;
                let found = {};
                let intents = [];
                d.forEach(item => {
                    item.intents.forEach(intent => {
                        if (!found[intent.name]){
                            intents.push({name:intent.name,displayName:intent.display_name});
                            found[intent.name] = [item];
                        }
                        else {
                            found[intent.name].push(item);
                        }
                    });
                });

                intents.forEach(intent =>{
                    let entry = {intent:intent,apps:found[intent.name]};

                    r.push(entry);
                });
                //get all apps for each distinct intent
/*                r.apps = msg.data;
                let intnt = r.apps[0].intents.filter(i => {return i.name === intent;});
                if (intnt.length > 0){
                    r.intent.name = intnt[0].name;
                    r.intent.displayName = intnt[0].display_name;
                }*/
                
                //set the intent metadata...
                document.dispatchEvent(new CustomEvent("FDC3:returnFindIntentsByContext", {detail:{data: r}})); 
                        
            }
        });
        //retrieve apps for the intent
        port.postMessage({topic:"findIntentsByContext", "context":e.detail.context});
        
    });

port.onMessage.addListener(msg => {
    if (msg.topic === "environmentData"){
        console.log("connected!", msg.data, eventQ);
        //we're now ready for general fdc3 comms with the background
        connected = true;
        //if there is a queue of pending events, then act on them, these will mostly be addContext/addIntent Listener calls
        eventQ.forEach(e => {
            port.postMessage(e); 
        });

        //if there is manifest content, wire up listeners if intents and context metadata are there
        let mani = msg.data.directory ? msg.data.directory.manifestContent : null;
        //set globals
        contentManifest = mani;

        if (mani){
            if (mani.intents){
                //iterate through the intents, and set listeners
                mani.intents.forEach(intent => {
                    port.postMessage({topic:"addIntentListener", "data": {intent:intent.intent }}); 
                    _intentHandlers.push(intent.intent);
                });
            }
            if (mani.contexts){
                //iterate through context metadata and set listeners
                mani.contexts.forEach(context => {
                    port.postMessage({topic:"addContextListener", "data": {context:context.type}}); 
                    _contextHandlers.push(context.type);
                });
            
            }
        }
        if (msg.data.currentChannel){
            currentChannel = msg.data.currentChannel;
            port.postMessage({topic:"joinChannel", "data": {channel:currentChannel}});      
        }
    }
   else  if (msg.topic === "context"){
       //check for handlers at the content script layer (automatic handlers) - if not, dispatch to the API layer...
       if (msg.data && msg.data.context){
        if (_contextHandlers.indexOf(msg.data.context.type) > -1 && contentManifest){
            let contextMeta = contentManifest.contexts.find(i => {
                return i.type === msg.data.context.type;
            });
            //set paramters
            let ctx = msg.data.context;
            let params = {};
        
                Object.keys(contentManifest.params).forEach(key =>{ 
                    let param = contentManifest.params[key];
                    if (ctx.type === param.type){
                        if (param.key && ctx[param.key]){
                            params[key] = ctx[param.key];
                        }
                        else if (param.id && ctx.id[param.id]){
                            params[key]  = ctx.id[param.id]; 
                        }
                    }
                });
            
            //eval the url
            let template = contentManifest.templates[contextMeta.template];
            Object.keys(params).forEach(key => {
                let sub = "${" + key + "}";
                let val = params[key];
                while (template.indexOf(sub) > -1){
                    template = template.replace(sub,val);
                }

            });
            //don't reload if they are the same...
            if (window.location.href !== template){
                window.location.href = template; 
            }
            //focus the actual tab
            window.focus();
        }
    }

        document.dispatchEvent(new CustomEvent("FDC3:context",{
            detail:{data:msg.data}
        }));
    }
    else if (msg.topic === "intent") {
        
        //check for handlers at the content script layer (automatic handlers) - if not, dispatch to the API layer...
        if (_intentHandlers.indexOf(msg.data.intent) > -1 && contentManifest){
            let intentData = contentManifest.intents.filter(i => {
              //  return (i.type && i.type === msg.data.context.type) && i.intent === msg.data.intent;
              return i.intent === msg.data.intent;
            });
            //check if there is more than one intent template with different context types
            if (intentData.length > 1 && msg.data.context.type){
                intentData = intentData.find(i => {
                    return (i.type === msg.data.context.type);
                });
            }
            if (Array.isArray(intentData)){
                intentData = intentData[0];
            }
            //set paramters
            let ctx = msg.data.context;
            let params = {};
           
                Object.keys(contentManifest.params).forEach(key =>{ 
                    let param = contentManifest.params[key];
                    if (ctx.type === param.type){
                        if (param.key && ctx[param.key]){
                            params[key] = ctx[param.key];
                        }
                        else if (param.id && ctx.id[param.id]){
                            params[key]  = ctx.id[param.id]; 
                        }
                    }
                });
            
            //eval the url
            let template = contentManifest.templates[intentData.template];
            Object.keys(params).forEach(key => {
                let sub = "${" + key + "}";
                let val = params[key];
                while (template.indexOf(sub) > -1){
                    template = template.replace(sub,val);
                }

            });
            //don't reload if they are the same...
            if (window.location.href !== template){
                window.location.href = template; 
            }
            window.focus();
        }
        document.dispatchEvent(new CustomEvent("FDC3:intent",{
            detail:{data:msg.data}
        })); 
    }

});

let resolver = null;
 document.addEventListener('keydown', k => {
     if (k.code === "Escape" ){
        document.dispatchEvent(new CustomEvent("FDC3:resolver-close",{
        })); 
       /* if (resolver){
            resolver.style.display = "none";
        }*/
    }
});

 
 //handle click on extension button
 //raise directory search overlay
 chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
        if (request.message === "get-tab-title"){
            sendResponse(document.title);
        }
        else if (request.message === "popup-get-current-channel"){
            console.log("currentChannel", currentChannel);
            sendResponse(currentChannel);
        }
        else if (request.message === "popup-join-channel"){
            currentChannel = request.channel;
            port.postMessage({topic:"joinChannel", "data": {channel:request.channel}}); 
        }
        else if (request.message === "popup-open"){
            port.postMessage({topic:"open", "data": {name:request.name}}); 
        }
  
      else if (request.message === "intent_resolver"){
        if (! resolver){
            resolver = createResolverRoot();
            document.body.appendChild(resolver);
        }
        resolver.style.display = "block";
        //resolve the intent name to the display name for the intent - by looking it up in the data response
        let dName = null;
        request.data.forEach(item => {
            if (!dName && Array.isArray(item.details.directoryData.intents)){
                item.details.directoryData.intents.forEach(intent => {
                    if(intent.name === request.intent){
                        dName = intent.display_name;
                    }
                });
            }
        } );
        let header = resolver.shadowRoot.querySelectorAll("#resolve-header")[0];
        header.innerText = `Intent '${(dName ? dName : request.intent)}'`;
        let list = resolver.shadowRoot.querySelectorAll("#resolve-list")[0];
        list.innerHTML = "";

        //contents
        request.data.forEach((item) => {
            let selected = item;
            let data = item.details.directoryData ? item.details.directoryData : null;
            let rItem = document.createElement("div");

            rItem.className = "item";
            let title = data ? data.title : "Untitled";
            let iconNode = document.createElement("img");
            iconNode.className = "icon";
            rItem.appendChild(iconNode);
            let titleNode = document.createElement("span");
            rItem.appendChild(titleNode);
            //title should reflect if this is creating a new window, or loading to an existing one
            if (item.type === "window"){
                let tab = item.details.port.sender.tab;
               // let icon = document.createElement("img");
               // icon.className = "icon"; 
                if (tab.favIconUrl){
                    iconNode.src = tab.favIconUrl;
                }
                //rItem.appendChild(icon);
                //titleNode = document.createElement("span");
                titleNode.id = "title-" + tab.id;
                titleNode.innerText = title;
                titleNode.title = `${title} (${tab.url})`;
                let query = "#title-" + tab.id;
                
                //async get the window title
                getTabTitle(tab.id).then(t => { 
                    let titles =  list.querySelectorAll(query);
                    if (titles.length > 0 && t.length > 0){
                        titles[0].innerText = t;
                        titles[0].title = `${t} (${tab.url})`;
                    }
                });
            }
            else {
                if (data && data.icons && data.icons.length > 0){
                    iconNode.src = data.icons[0].icon;
                }
            }
            if (titleNode){
                if (titleNode.innerText.length === 0){
                    titleNode.innerText = title;
                }
                if (titleNode.title.length === 0){
                    titleNode.title = data ? data.start_url : (tab ? tab.title : "Untitled");
                }
                
            }
            rItem.addEventListener("click",evt => {
                //send resolution message to extension to route
               // console.log(`intent resolved (window).  selected = ${JSON.stringify(selected)} intent = ${JSON.stringify(request.intent)} contect = ${JSON.stringify(request.context)}`)
                port.postMessage({
                    topic:request.eventId,
                    intent:request.intent,
                    selected:selected,
                    context:request.context
                }); 
                list.innerHTML = "";
                resolver.style.display = "none";
            });
            list.appendChild(rItem);
        });
      }

    }
    
  );

  function createResolverRoot(){
 
        // Create root element
        let root = document.createElement('div');
        let wrapper = document.createElement('div');
        wrapper.id = "fdc3-intent-resolver";

         // Create a shadow root
         var shadow = root.attachShadow({mode: 'open'});

        // Create some CSS to apply to the shadow dom
        const style = document.createElement('style');

        style.textContent = `
        #fdc3-intent-resolver {
            width:400px;
            height:400px;
            margin-left:-200px;
            margin-top:-200px;
            left:50%;
            top:50%;
            background-color:#444;
            position:absolute;
            z-index:9999;
            font-family:sans-serif;
            filter: drop-shadow(6px 4px 1px #969696);
            border-radius: 10px;
   
        }

        #resolve-header {
            height:25px;
            color:#eee;
            font-size: 18px;
            width: 100%;
            text-align: center;
            padding-top: 10px;
        }
        
        #resolve-subheader {
            height:20px;
            color:#eee;
            font-size: 16px;
            width: 100%;
            text-align: center;
        }
        #resolve-list {
            height:300px;
            overflow:scroll;
            margin:10px;
            font-size:14px;
            border-radius: 3px;
            margin: 3px;
            border: #333;
            background-color: #555;
        }
        
        #resolve-list .item {
            color:#fff;
            flexFlow:row;
            height:20px;
            padding:3px;
            overflow:hidden;
        }


        #resolve-list .item .icon {
           height:20px;
           padding-right:3px;
        }
        
        #resolve-list .item:hover {
            background-color:#999;
            color:#ccc;
            cursor: pointer;
        }
        `;
        let header = document.createElement('div');
        header.id = "resolve-header";
        wrapper.appendChild(header);
        let subheader = document.createElement('div');
        subheader.id = "resolve-subheader";
        subheader.innerText = "choose an app";
        wrapper.appendChild(subheader);
        let list = document.createElement('div');
        list.id = "resolve-list";
        wrapper.appendChild(list);
        
        // Attach the created elements to the shadow dom
        shadow.appendChild(style);
        shadow.appendChild(wrapper);
        

      
        return root;
    }
  

  //inject the FDC3 API
  let s = document.createElement('script');
  s.src = chrome.extension.getURL('api.js');
  s.onload = function() {
      this.parentNode.removeChild(this);
  };
  (document.head||document.documentElement).appendChild(s);