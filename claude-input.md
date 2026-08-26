Chrome devtools console:

```
Content-Security-Policy: The page’s settings blocked an inline script (script-src-elem) from being executed because it violates the following directive: “script-src 'self'”. Consider using a hash ('sha256-PSbJmyvxZNzvRDi+D/Qj0klN/RcQ2sw/ms/fz2MzO6Y=') or a nonce. prepareInjection.js:1:1063
Content-Security-Policy: The page’s settings blocked an inline script (script-src-elem) from being executed because it violates the following directive: “script-src 'self'”. Consider using a hash ('sha256-STS9SqU0XU6MD9z/R5Vuu133130JZh3udAlYzLFvda4=') or a nonce. prepareInjection.js:1:1063
Layout was forced before the page was fully loaded. If stylesheets are not yet loaded this may cause a flash of unstyled content. contentscript.js:14083:441406
Window.fullScreen attribute is deprecated and will be removed in the future. contentscript.js:14083:441406
InstallTrigger is deprecated and will be removed in the future. contentscript.js:14083:441406
onmozfullscreenchange is deprecated. contentscript.js:14083:441406
onmozfullscreenerror is deprecated. contentscript.js:14083:441406
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added. Use emitter.setMaxListeners() to increase limit
    u moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    addListener moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    on moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14082
    once moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    pipe moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    B moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    D moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    P moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    M moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    C moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    <anonymous> moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    <anonymous> moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    <anonymous> moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    <anonymous> moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
contentscript.js:14083:34262
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 end listeners added. Use emitter.setMaxListeners() to increase limit
    u moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    addListener moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    on moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14082
    O moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    B moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    D moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    P moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    M moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    C moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14063
    <anonymous> moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    <anonymous> moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    <anonymous> moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
    <anonymous> moz-extension://251c25be-de42-4633-ae9e-c39b5c78267b/scripts/contentscript.js:14083
contentscript.js:14083:34262
Content-Security-Policy: The page’s settings blocked an inline script (script-src-elem) from being executed because it violates the following directive: “script-src 'self'”. Consider using a hash ('sha256-aN7X3uYSfjphIA0P6sX0ysnrWWpbenzhDq3RyEEjxqU=') or a nonce. inpage.js:1:358533
ObjectMultiplex - orphaned data for stream "background-liveness" 2 contentscript.js:14083:442882
Uncaught TypeError: can't access property "enhanceEndpoints", Ep is undefined
    <anonymous> https://portal.dev.mjukvaruhuset.se/assets/index-Bk1_TY9d.js:12
index-Bk1_TY9d.js:12:107396
ObjectMultiplex - orphaned data for stream "metamask-multichain-provider" 4 inpage.js;:1:28380
Error: Promised response from onMessage listener went out of scope chrome.js:129:30

​

```