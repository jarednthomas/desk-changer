/**
 * Copyright (c) 2018 Eric Gach <eric.gach@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;
const Lang = imports.lang;
const Gio = imports.gi.Gio;
const Signals = imports.signals;

const debug = Me.imports.utils.debug;
const MAX_QUEUE_LENGTH = 100;

const DeskChangerProfileQueue = new Lang.Class({
    Name: 'DeskChangerProfileQueue',

    _init: function () {
        this.queue = [];
    },

    get length() {
        return this.queue.length;
    },

    get preview() {
        return (this.queue.length > 0)? this.queue[this.queue.length - 1] : undefined;
    },

    clear: function () {
        this.queue = [];
    },

    dequeue: function () {
        if (this.queue.length === 0) return undefined;
        return this.queue.pop();
    },

    enqueue: function (uri) {
        this.queue.push(uri);

        while (this.queue.length > MAX_QUEUE_LENGTH) {
            this.queue.unshift();
        }
    },

    in_queue: function (uri) {
        return (uri in this.queue);
    },

    remove: function (uri) {
        let index = this.queue.indexOf(uri);

        if (index >= 0) {
            this.queue.splice(index, 1);
            return true;
        }

        return false;
    },

    restore: function (queue) {
        this.queue = queue;
    }
});

var DeskChangerProfileError = new Lang.Class({
    Name: 'DeskChangerProfileError',

    _init: function(message, profile=null) {
        this.message = message;
        this.profile = profile;
    }
});


var DeskChangerProfileErrorNoWallpaper = Lang.Class({
    Name: 'DeskChangerProfileErrorNoWallpaper',
    Extends: DeskChangerProfileError,

    _init: function (num_locations, profile) {
        this.parent(_('no wallpapers loaded from %d locations in profile %s'.format(num_locations, profile.profile_name)), profile);
    }
});


const DeskChangerProfileBase = new Lang.Class({
    Name: 'DeskChangerProfileBase',
    Abstract: true,

    /**
     *
     * @param profile_name
     * @param settings DeskChangerSettings
     * @private
     */
    _init: function (key, settings) {
        this._key = key;
        this._key_normalized = key.replace(new RegExp('-', 'g'), '_');
        this._settings = settings;
        this._profile_name = this._settings[this._key_normalized];
        this._history = new DeskChangerProfileQueue();
        this._loaded = false;
        this._monitors = [];
        this._queue = new DeskChangerProfileQueue();
        this._sequence = 0;
        this._wallpapers = [];

        if (!this.hasOwnProperty('_background')) {
            throw 'must have property _background';
        }

        this._profile_changed_id = this._settings.connect('changed::' + key, Lang.bind(this, this._profile_changed));
    },

    destroy: function () {
        if (this._profile_changed_id) {
            this._settings.disconnect(this._profile_changed_id);
        }

        this.unload();
    },

    load: function () {
        let profile = null;

        // Ensure we unload first, resetting all our internals
        this.unload();

        if (!this._settings.profiles.hasOwnProperty(this.profile_name)) {
            throw 'profile %s does not exist'.format(this.profile_name);
        }

        debug('loading profile %s'.format(this.profile_name));
        profile = this._settings.profiles[this.profile_name];
        profile.forEach(Lang.bind(this, function (item) {
            let [uri, recursive] = item;
            this._load_uri(uri, recursive, true);
        }));

        if (this._wallpapers.length === 0) {
            throw new DeskChangerProfileErrorNoWallpaper(profile.length, this);
        } else if (this._wallpapers.length === 1) {
            throw new DeskChangerProfileError(_('only one wallpaper is loaded for %s, rotation is disabled'.format(this.profile_name)), this);
        } else if (this._wallpapers.length < MAX_QUEUE_LENGTH) {
            debug('unable to guarantee random rotation - wallpaper count is under %d(%d)'.format(MAX_QUEUE_LENGTH, this._wallpapers.length));
        }

        this._wallpapers.sort();
        // Now load up the queue
        this._fill_queue();
        this._loaded = true;
        this.emit('loaded');
        debug('profile %s loaded with %d wallpapers'.format(this.profile_name, this._wallpapers.length));
    },

    next: function (_current = true) {
        let current = (_current)? this._background.get_string('picture-uri') : null,
            wallpaper = this._queue.dequeue();

        if (current) {
            this._history.enqueue(current);
        }

        this._set_wallpaper(wallpaper);
        this._fill_queue();
        return wallpaper;
    },

    prev: function () {
        let wallpaper;

        if (this._history.length === 0) {
            throw new DeskChangerProfileError(_('No more wallpapers available in history'), this);
        }

        wallpaper = this._history.dequeue();
        this._queue.enqueue(this._background.get_string('picture-uri'));
        this._emit_preview();
        this._set_wallpaper(wallpaper);
        return wallpaper;
    },

    unload: function () {
        this._monitors.forEach(function (monitor) {
            monitor.cancel();
        });

        this._history.clear();
        this._monitors = [];
        this._queue.clear();
        this._sequence = 0;
        this._wallpapers = [];
        this._loaded = false;
        debug('profile %s unloaded'.format(this.profile_name));
    },

    get loaded() {
        return this._loaded;
    },

    get preview() {
        return this._queue.preview;
    },

    get profile_name() {
        if (this._profile_name === '') {
            return '(inherited)';
        }

        return this._profile_name;
    },

    _emit_preview: function () {
        this.emit('preview', this.preview);
    },

    _file_changed: function () {
        // TODO: write the code to detect file changes in directories
    },

    _fill_queue: function () {
        let wallpaper;

        if (this._queue.length > 0) {
            // Queue only needs one item at minimum
            debug('wallpaper queue already has %d in it, skipping'.format(this._queue.length));
            this._emit_preview();
            return;
        }

        if (this._settings.random) {
            do {
                wallpaper = this._wallpapers[Math.floor(Math.random() * this._wallpapers.length)];

                if (this._background.get_string('picture-uri') === wallpaper) {
                    // current wallpaper. oh noes!
                    wallpaper = null;
                } else if (this._history.in_queue(wallpaper) && (this._wallpapers.length >= MAX_QUEUE_LENGTH || this._history[0] === wallpaper)) {
                    // Already shown too recently, try again
                    wallpaper = null;
                } else if (this._queue.in_queue(wallpaper) && (this._wallpapers.length >= MAX_QUEUE_LENGTH || this._queue.length < this._wallpapers.length)) {
                    // Already in the queue, try again
                    wallpaper = null;
                }
            } while (wallpaper === null);

        } else {
            wallpaper = this._wallpapers[this._sequence++];
            if (this._sequence > this._wallpapers.length) {
                this._sequence = 0;
            }
        }

        this._queue.enqueue(wallpaper);
        this._emit_preview();
        debug('added %s to the queue'.format(wallpaper));
    },

    _load_children: function (location, recursive) {
        let enumerator, item;

        try {
            enumerator = location.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            debug('failed to load %s from profile %s (%s)'.format(location.get_uri(), this.profile_name, e));
            return;
        }

        while ((item = enumerator.next_file(null)) !== null) {
            let child = location.resolve_relative_path(item.get_name());
            if (child) {
                this._load_uri(child.get_uri(), recursive);
            }
        }
    },

    _load_uri: function (uri, recursive, top_level=false) {
        let location = null,
            info = null;

        debug('loading uri %s%s'.format(uri, recursive? ' recursively' : ''));

        try {
            location = Gio.File.new_for_uri(uri);
            info = location.query_info('standard::*', Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            debug('failed to get info for %s on profile %s (%s)'.format(uri, this.profile_name, e));
            return;
        }

        if (info.get_file_type() === Gio.FileType.DIRECTORY && (recursive || top_level)) {
            let monitor = location.monitor_directory(Gio.FileMonitorFlags.NONE, new Gio.Cancellable());
            monitor.connect('changed', Lang.bind(this, this._file_changed));
            this._monitors.push(monitor);
            this._load_children(location, recursive);
        } else if (info.get_file_type() === Gio.FileType.REGULAR && this._settings.allowed_mime_types.includes(info.get_content_type())) {
            if (location.get_uri() in this._wallpapers) {
                debug('ignoring duplicate file %s on profile %s'.format(location.get_uri(), this.profile_name));
                return;
            }

            this._wallpapers.push(location.get_uri());
        } else {
            debug('skipping %s(%s)'.format(location.get_uri(), info.get_content_type()));
        }
    },

    _profile_changed: function (settings, key) {
        let loaded = this.loaded;

        if (loaded) {
            this.unload();
        }

        this._profile_name = this._settings[this._key_normalized];

        if (loaded) {
            this.load();
        }
    },

    _set_wallpaper: function (wallpaper) {
        debug('setting wallpaper for %s(%s) to %s'.format(this.__name__, this.profile_name, wallpaper));
        this._background.set_string('picture-uri', wallpaper);
        this.emit('changed', wallpaper);
    },
});

Signals.addSignalMethods(DeskChangerProfileBase.prototype);


var DeskChangerProfileDesktop = new Lang.Class({
    Name: 'DeskChangerProfileDesktop',
    Extends: DeskChangerProfileBase,

    _init: function (settings) {
        this._background = Convenience.getSettings('org.gnome.desktop.background');
        this.parent('current-profile', settings);
    },

    restore_state: function () {
        if (this._settings.profile_state.hasOwnProperty(this.profile_name)) {
            this._queue.restore(this._settings.profile_state[this.profile_name]);
            let profile_state = this._settings.profile_state;
            delete profile_state[this.profile_name];
            this._settings.profile_state = profile_state;
            debug('restored state of profile %s'.format(this.profile_name));
        }
    },

    save_state: function () {
        if (this._queue.length === 0) {
            debug('ERROR: failed to save state of profile %s because queue is empty'.format(this.profile_name));
            return;
        } else if (this._settings.profile_state.hasOwnProperty(this.profile_name)) {
            debug('overwriting state of profile %s'.format(this.profile_name));
        }

        let profile_state = this._settings.profile_state;
        profile_state[this.profile_name] = [this._queue.preview, this._background.get_string('picture-uri')];
        this._settings.profile_state = profile_state;
        debug('saved state of profile %s'.format(this.profile_name));
    },

    unload: function ()
    {
        if (this.loaded && this._settings.remember_profile_state) {
            this.save_state();
        }

        this.parent();
    },

    _fill_queue: function () {
        if (this._settings.remember_profile_state) {
            this.restore_state();
        }

        this.parent();
    },

    _profile_changed: function (settings, key) {
        if (this.loaded && this._settings.remember_profile_state) {
            this.save_state();
        }

        this.parent(settings, key);
    },
});


var DeskChangerProfileLockscreen = new Lang.Class({
    Name: 'DeskChangerProfileLockscreen',
    Extends: DeskChangerProfileBase,

    _init: function (settings) {
        this._background = Convenience.getSettings('org.gnome.desktop.screensaver');
        this.parent('lockscreen-profile', settings);
        this._update_lockscreen_id = this._settings.connect('changed::update-lockscreen', Lang.bind(this, function (settings, key) {
            if (this._settings.update_lockscreen && this._settings.lockscreen_profile === '' && this._settings.auto_rotate) {
                this._inherit_wallpaper();
            }
        }));
    },

    _profile_changed: function (settings, key) {
        if (this.loaded && this._settings.lockscreen_profile === '') {
            this.unload();
        }

        this.parent(settings, key);

        if (!this.loaded && this._settings.update_lockscreen && this._profile_name) {
            this.load();
        } else if (!this.loaded && this._settings.update_lockscreen) {
            this._inherit_wallpaper();
        }
    },

    _inherit_wallpaper: function () {
        // slight hack... this is the only place we can really update the lockscreen when we revert to inherited
        let settings = Convenience.getSettings('org.gnome.desktop.background');
        this._set_wallpaper(settings.get_string('picture-uri'));
        settings.destroy();
    }
});