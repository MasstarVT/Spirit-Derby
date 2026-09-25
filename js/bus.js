/*
 * Spirit Derby - bus.js
 * Tiny synchronous event bus. Listener errors are caught and logged so one broken
 * panel can never break the game loop.
 */
(function (SD) {
  'use strict';

  SD.EVENTS = {
    STATE_CHANGED: 'state:changed',
    STATE_LOADED: 'state:loaded',
    SETTINGS_CHANGED: 'settings:changed',
    LOG_ENTRY: 'log:entry',
    RUNNER_SPAWNED: 'runner:spawned',
    RUNNER_TRAINED: 'runner:trained',
    RUNNER_RESTED: 'runner:rested',
    RUNNER_CLAIMED: 'runner:claimed',
    RUNNER_LEVELUP: 'runner:levelup',
    RUNNER_CONDITION: 'runner:condition',
    PLAYER_JOINED: 'player:joined',
    PLAYER_SP: 'player:sp',
    HYPE_CHANGED: 'hype:changed',
    HYPE_THRESHOLD: 'hype:threshold',
    BET_PLACED: 'bet:placed',
    BET_RESOLVED: 'bet:resolved',
    EVENT_DAY: 'event:day',
    RACE_STARTED: 'race:started',
    RACE_COUNTDOWN: 'race:countdown',
    RACE_FRAME: 'race:frame',
    RACE_TICK: 'race:tick',
    RACE_PHASE: 'race:phase',
    RACE_EVENT: 'race:event',
    RACE_RUNNER_FINISHED: 'race:runnerFinished',
    RACE_PAUSED: 'race:paused',
    RACE_RESUMED: 'race:resumed',
    RACE_END_REQUESTED: 'race:endRequested',
    RACE_PLAYBACK_DONE: 'race:playbackDone',
    RACE_FINISHED: 'race:finished',
    RACE_ABORTED: 'race:aborted',
    SEASON_DAY_ADVANCED: 'season:dayAdvanced',
    SEASON_ENDED: 'season:ended',
    SEASON_STARTED: 'season:started',
    ACHIEVEMENT_UNLOCKED: 'achievement:unlocked',
    CHAT_MESSAGE: 'chat:message',
    COMMAND_RESULT: 'command:result',
    INTEGRATION_STATUS: 'integration:status'
  };

  const listeners = Object.create(null); // name -> [fn]
  const wildcards = [];

  function reportError(name, err) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[SD.bus] listener for "' + name + '" threw:', err);
    }
  }

  function on(name, fn) {
    if (typeof fn !== 'function') return function () {};
    (listeners[name] || (listeners[name] = [])).push(fn);
    return function unsubscribe() { off(name, fn); };
  }

  function once(name, fn) {
    const unsub = on(name, function wrapper(payload) {
      unsub();
      fn(payload);
    });
    return unsub;
  }

  function off(name, fn) {
    const list = listeners[name];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  // Listen to every event: fn(name, payload). Returns an unsubscribe function.
  function wildcard(fn) {
    if (typeof fn !== 'function') return function () {};
    wildcards.push(fn);
    return function () {
      const i = wildcards.indexOf(fn);
      if (i >= 0) wildcards.splice(i, 1);
    };
  }

  function emit(name, payload) {
    const list = listeners[name];
    if (list && list.length) {
      const snapshot = list.slice(); // listeners may unsubscribe while we iterate
      for (let i = 0; i < snapshot.length; i++) {
        try { snapshot[i](payload); } catch (err) { reportError(name, err); }
      }
    }
    if (wildcards.length) {
      const ws = wildcards.slice();
      for (let i = 0; i < ws.length; i++) {
        try { ws[i](name, payload); } catch (err) { reportError(name, err); }
      }
    }
  }

  // Remove every listener (tests only).
  function clear() {
    Object.keys(listeners).forEach(function (k) { delete listeners[k]; });
    wildcards.length = 0;
  }

  SD.bus = { on: on, once: once, off: off, emit: emit, wildcard: wildcard, clear: clear };
})(globalThis.SD = globalThis.SD || {});
