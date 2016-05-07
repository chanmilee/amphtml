/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {dev} from '../log';
import {getService} from '../service';
import {resourcesFor} from '../resources';
import {timer} from '../timer';
import {user} from '../log';
import {viewportFor} from '../viewport';

/** @const {number} */
const LISTENER_INITIAL_RUN_DELAY_ = 20;

// Variables that are passed to the callback.
const MAX_CONTINUOUS_TIME = 'maxContinuousTime';
const TOTAL_TIME = 'totalVisibleTime';
const FIRST_SEEN_TIME = 'firstSeenTime';
const LAST_SEEN_TIME = 'lastSeenTime';
const FIRST_VISIBLE_TIME = 'fistVisibleTime';
const LAST_VISIBLE_TIME = 'lastVisibleTime';
const MIN_VISIBLE = 'minVisiblePercentage';
const MAX_VISIBLE = 'maxVisiblePercentage';

// Variables that are not exposed outside this class.
const CONTINUOUS_TIME = 'cT';
const LAST_UPDATE = 'lU';
const IN_VIEWPORT = 'iV';
const TIME_LOADED = 'tL';

// Keys used in VisibilitySpec
const CONTINUOUS_TIME_MAX = 'continuousTimeMax';
const CONTINUOUS_TIME_MIN = 'continuousTimeMin';
const TOTAL_TIME_MAX = 'totalTimeMax';
const TOTAL_TIME_MIN = 'totalTimeMin';
const VISIBLE_PERCENTAGE_MIN = 'visiblePercentageMin';
const VISIBLE_PERCENTAGE_MAX = 'visiblePercentageMax';

/**
 * Checks if the value is undefined or positive number like.
 * "", 1, 0, undefined, 100, 101 are positive. -1, NaN are not.
 *
 * Visible for testing.
 *
 * @param {number} num The number to verify.
 * @return {boolean}
 * @private
 */
export function isPositiveNumber_(num) {
  return num === undefined || Math.sign(num) >= 0;
}

/**
 * Checks if the value is undefined or a number between 0 and 100.
 * "", 1, 0, undefined, 100 return true. -1, NaN and 101 return false.
 *
 * Visible for testing.
 *
 * @param {number} num The number to verify.
 * @return {boolean}
 */
export function isValidPercentage_(num) {
  return num === undefined || (Math.sign(num) >= 0 && num <= 100);
}

/**
 * Checks and outputs information about visibilitySpecValidation.
 * @param {!JSONObject} config Configuration for instrumentation.
 * @return {boolean} True if the spec is valid.
 * @private
 */
export function isVisibilitySpecValid(config) {
  if (!config['visibilitySpec']) {
    return true;
  }

  const spec = config['visibilitySpec'];
  if (!spec['selector'] || spec['selector'][0] != '#') {
    user.error('Visibility spec requires an id selector');
    return false;
  }

  const ctMax = spec[CONTINUOUS_TIME_MAX];
  const ctMin = spec[CONTINUOUS_TIME_MIN];
  const ttMax = spec[TOTAL_TIME_MAX];
  const ttMin = spec[TOTAL_TIME_MIN];

  if (!isPositiveNumber_(ctMin) || !isPositiveNumber_(ctMax) ||
      !isPositiveNumber_(ttMin) || !isPositiveNumber_(ttMax)) {
    user.error('Timing conditions should be positive integers when specified.');
    return false;
  }

  if ((ctMax || ttMax) && !spec['unload']) {
    user.warn('Unload condition should be used when using ' +
        ' totalTimeMax or continuousTimeMax');
    return false;
  }

  if (ctMax < ctMin || ttMax < ttMin) {
    user.warn('Max value in timing conditions should be more ' +
        'than the min value.');
    return false;
  }

  if (!isValidPercentage_(spec[VISIBLE_PERCENTAGE_MAX]) ||
      !isValidPercentage_(spec[VISIBLE_PERCENTAGE_MIN])) {
    user.error('visiblePercentage conditions should be between 0 and 100.');
    return false;
  }

  if (spec[VISIBLE_PERCENTAGE_MAX] < spec[VISIBLE_PERCENTAGE_MIN]) {
    user.error('visiblePercentageMax should be greater than ' +
        'visiblePercentageMin');
    return false;
  }
  return true;
}


/**
 * This type signifies a callback that gets called when visibility conditions
 * are met.
 * @typedef {function()}
 */
let VisibilityListenerCallbackDef;

/**
 * @typedef {Object<string, JSONObject|VisibilityListenerCallbackDef|Object>}
 */
let VisibilityListenerDef;

/**
 * Allows tracking of AMP elements in the viewport.
 *
 * This class allows a caller to specify conditions to evaluate when an element
 * is in viewport and for how long. If the conditions are satisfied, a provided
 * callback is called.
 */
export class Visibility {

  /** @param {!Window} */
  constructor(win) {
    this.win_ = win;

    /**
     * key: resource id.
     * value: [{ config: <config>, callback: <callback>, state: <state>}]
     * @type {Object<string, Array.<VisibilityListenerDef>>}
     * @private
     */
    this.listeners_ = Object.create(null);

    /** @private {Array<!Resource>} */
    this.resources_ = [];

    /** @private @const {function} */
    this.boundScrollListener_ = this.scrollListener_.bind(this);

    /** @private {boolean} */
    this.scrollListenerRegistered_ = false;

    /** @private {!Resources} */
    this.resourcesService_ = resourcesFor(this.win_);

    /** @private {number|string} */
    this.scheduledRunId_ = null;

    /** @private {number} Amount of time to wait for next calculation. */
    this.timeToWait_ = Infinity;

    /** @private {boolean} */
    this.scheduledLoadedPromises_ = false;
  }

  /** @private */
  registerForViewportEvents_() {
    if (!this.scrollListenerRegistered__) {
      const viewport = viewportFor(this.win_);

      // Currently unlistens are not being used. In the event that no resources
      // are actively being monitored, the scrollListener should be very cheap.
      viewport.onScroll(this.boundScrollListener_);
      viewport.onChanged(this.boundScrollListener_);
      this.scrollListenerRegistered_ = true;
    }

  }

  /**
   * @param {!JSONObject} config
   * @param {!VisibilityListenerCallbackDef} callback
   */
  listenOnce(config, callback) {
    const element = this.win_.document.getElementById(config['selector']
        .slice(1));
    const res = this.resourcesService_.getResourceForElement(element);
    const resId = res.getId();

    this.registerForViewportEvents_();

    this.listeners_[resId] = (this.listeners_[resId] || []);
    this.listeners_[resId].push({
      config: config,
      callback: callback,
      state: {[TIME_LOADED]: Date.now()},
    });
    this.resources_.push(res);

    if (this.scheduledRunId_ == null) {
      this.scheduledRunId_ = timer.delay(() => {
        this.scrollListener_();
      }, LISTENER_INITIAL_RUN_DELAY_);
    }
  }

  /** @private */
  scrollListener_() {
    if (this.scheduledRunId_ != null) {
      timer.cancel(this.scheduledRunId_);
      this.scheduledRunId_ = null;
    }

    this.timeToWait = Infinity;
    const loadedPromises = [];

    for (let r = this.resources_.length - 1; r >= 0; r--) {
      const res = this.resources_[r];
      if (res.isLayoutPending()) {
        loadedPromises.push(res.loaded());
        continue;
      }

      const change = res.element.getIntersectionChangeEntry();
      const ir = change.intersectionRect;
      const br = change.boundingClientRect;
      const visible = ir.width * ir.height * 100 / (br.height * br.width);

      const listeners = this.listeners_[res.getId()];
      for (let c = listeners.length - 1; c >= 0; c--) {
        if (this.updateCounters_(visible, listeners[c])) {

          // Remove the state that need not be public and call callback.
          delete listeners[c]['state'][CONTINUOUS_TIME];
          delete listeners[c]['state'][LAST_UPDATE];
          delete listeners[c]['state'][IN_VIEWPORT];
          listeners[c].callback(listeners[c]['state']);
          listeners.splice(c, 1);
        }
      }

      // Remove resources that have no listeners.
      if (listeners.length == 0) {
        this.resources_.splice(r, 1);
      }
    }

    // Schedule a calculation for the time when one of the conditions is
    // expected to be satisfied.
    if (this.scheduledRunId_ == null &&
        this.timeToWait_ < Infinity && this.timeToWait_ > 0) {
      this.scheduledRunId_ = timer.delay(() => {
        this.scrollListener_();
      }, this.timeToWait_);
    }

    // Schedule a calculation for when a resource gets loaded.
    if (loadedPromises.length > 0 && !this.scheduledLoadedPromises_) {
      Promise.race(loadedPromises).then(() => {
        this.scheduledLoadedPromises_ = false;
        this.scrollListener_();
      });
      this.scheduledLoadedPromises_ = true;
    }
  }

  /**
   * Updates counters for a given listener.
   * @return {boolean} true if all visibility conditions are satisfied
   * @private
   */
  updateCounters_(visible, listener) {
    const config = listener['config'];
    const state = listener['state'] || {};

    if (visible > 0) {
      state[FIRST_SEEN_TIME] = state[FIRST_SEEN_TIME] ||
          Date.now() - state[TIME_LOADED];
      state[LAST_SEEN_TIME] = Date.now() - state[TIME_LOADED];
    }

    const wasInViewport = state[IN_VIEWPORT];
    const timeSinceLastUpdate = Date.now() - state[LAST_UPDATE];
    state[IN_VIEWPORT] = this.isInViewport_(visible,
        config[VISIBLE_PERCENTAGE_MIN], config[VISIBLE_PERCENTAGE_MAX]);

    if (!state[IN_VIEWPORT] && !wasInViewport) {
      return;  // Nothing changed.
    } else if (!state[IN_VIEWPORT] && wasInViewport) {
      // The resource went out of view. Do final calculations and reset state.
      dev.assert(state[LAST_UPDATE] > 0, 'lastUpdated time in weird state.');

      state[MAX_CONTINUOUS_TIME] = Math.max(state[MAX_CONTINUOUS_TIME],
          state[CONTINUOUS_TIME] + timeSinceLastUpdate);

      state[LAST_UPDATE] = -1;
      state[TOTAL_TIME] += timeSinceLastUpdate;
      state[CONTINUOUS_TIME] = 0;  // Clear only after max is calculated above.
      state[LAST_VISIBLE_TIME] = Date.now() - state[TIME_LOADED];
    } else if (state[IN_VIEWPORT] && !wasInViewport) {
      // The resource came into view. start counting.
      dev.assert(state[LAST_UPDATE] == undefined ||
          state[LAST_UPDATE] == -1, 'lastUpdated time in weird state.');
      state[FIRST_VISIBLE_TIME] = state[FIRST_VISIBLE_TIME] ||
          Date.now() - state[TIME_LOADED];
      this.setState_(state, visible, 0);
    } else {
      // Keep counting.
      this.setState_(state, visible, timeSinceLastUpdate);
    }

    const waitForContinuousTime = config[CONTINUOUS_TIME_MIN]
        ? config[CONTINUOUS_TIME_MIN] - state[CONTINUOUS_TIME]
        : Infinity;
    const waitForTotalTime = config[TOTAL_TIME_MIN]
        ? config[TOTAL_TIME_MIN] - state[TOTAL_TIME]
        : Infinity;

    // Wait for minimum of (previous timeToWait, positive values of
    // waitForContinuousTime and waitForTotalTime).
    this.timeToWait_ = Math.min(this.timeToWait,
        waitForContinuousTime > 0 ? waitForContinuousTime : Infinity,
        waitForTotalTime > 0 ? waitForTotalTime : Infinity);
    listener['state'] = state;
    return state[IN_VIEWPORT] &&
        (config[TOTAL_TIME_MIN] === undefined ||
         state[TOTAL_TIME] >= config[TOTAL_TIME_MIN]) &&
        (config[TOTAL_TIME_MAX] === undefined ||
         state[TOTAL_TIME] <= config[TOTAL_TIME_MAX]) &&
        (config[CONTINUOUS_TIME_MIN] === undefined ||
         state[CONTINUOUS_TIME] >= config[CONTINUOUS_TIME_MIN]) &&
        (config[CONTINUOUS_TIME_MAX] === undefined ||
         state[CONTINUOUS_TIME] <= config[CONTINUOUS_TIME_MAX]);
  }

  /**
   * For the purposes of these calculations, a resource is in viewport if the
   * visbility conditions are satisfied or they are not defined.
   * @param {!number} visible Percentage of element visible
   * @param {number} min Lower bound of visibility condition. Not inclusive
   * @param {number} max Upper bound of visibility condition. Inclusive.
   * @return {boolean} true if the conditions are satisfied.
   * @private
   */
  isInViewport_(visible, min, max) {
    if (min === undefined && max === undefined) {
      return true;
    }

    if (visible > (min || 0) && visible <= (max || 100)) { // (Min, Max]
      return true;
    }
    return false;
  }

  /** @private */
  setState_(s, visible, sinceLast) {
    s[LAST_UPDATE] = Date.now();
    s[TOTAL_TIME] = s[TOTAL_TIME] !== undefined ? s[TOTAL_TIME] + sinceLast : 0;
    s[CONTINUOUS_TIME] = s[CONTINUOUS_TIME] !== undefined
        ? s[CONTINUOUS_TIME] + sinceLast : 0;
    s[MAX_CONTINUOUS_TIME] = s[MAX_CONTINUOUS_TIME] !== undefined
        ? Math.max(s[MAX_CONTINUOUS_TIME], s[CONTINUOUS_TIME]) : 0;
    s[MIN_VISIBLE] = s[MIN_VISIBLE] ? Math.min(s[MIN_VISIBLE], visible) : 101;
    s[MAX_VISIBLE] = s[MAX_VISIBLE] ? Math.max(s[MAX_VISIBLE], visible) : -1;
    s[LAST_VISIBLE_TIME] = Date.now() - s[TIME_LOADED];
  }
}

/**
 * @param  {!Window} win
 * @return {!Visibility}
 */
export function installVisibilityService(win) {
  return getService(win, 'visibility', () => {
    return new Visibility(win);
  });
};