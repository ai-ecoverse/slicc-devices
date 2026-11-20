export const LIMIT = 512;
export const NOTIFY_BUFFER = 64;
export const HALT_BUSY_MS = 1000;
export const WAITING = "waiting for a click in seven's tab: choose a Bluetooth device";
export const OFF = "Bluetooth devices are off in seven's settings";
export const MISSING = 'this browser has no Web Bluetooth (use Chrome, Edge or Opera on a desktop)';
export const CANCELLED = 'no Bluetooth device was chosen';
export const LATE = 'nobody clicked within 5 min';
export const UNCLICKED = "choosing a Bluetooth device needs a click in seven's tab";
const QUIET = 250;

const reading = Object.freeze({ group: 'bluetooth', session: false });
const writing = Object.freeze({ session: false });

export const kinds = Object.freeze({
  'ble.list': reading,
  'ble.request': reading,
  'ble.connect': reading,
  'ble.disconnect': reading,
  'ble.services': reading,
  'ble.read': reading,
  'ble.notify': reading,
  'ble.write': writing,
});

const BASE = '00000000-0000-1000-8000-00805f9b34fb';
const FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SERVICES = Object.freeze({
  generic_access: 0x1800,
  generic_attribute: 0x1801,
  immediate_alert: 0x1802,
  link_loss: 0x1803,
  tx_power: 0x1804,
  current_time: 0x1805,
  reference_time_update: 0x1806,
  next_dst_change: 0x1807,
  glucose: 0x1808,
  health_thermometer: 0x1809,
  device_information: 0x180a,
  heart_rate: 0x180d,
  phone_alert_status: 0x180e,
  battery_service: 0x180f,
  blood_pressure: 0x1810,
  alert_notification: 0x1811,
  human_interface_device: 0x1812,
  scan_parameters: 0x1813,
  running_speed_and_cadence: 0x1814,
  automation_io: 0x1815,
  cycling_speed_and_cadence: 0x1816,
  cycling_power: 0x1818,
  location_and_navigation: 0x1819,
  environmental_sensing: 0x181a,
  body_composition: 0x181b,
  user_data: 0x181c,
  weight_scale: 0x181d,
  bond_management: 0x181e,
  continuous_glucose_monitoring: 0x181f,
  internet_protocol_support: 0x1820,
  indoor_positioning: 0x1821,
  pulse_oximeter: 0x1822,
  http_proxy: 0x1823,
  transport_discovery: 0x1824,
  object_transfer: 0x1825,
  fitness_machine: 0x1826,
  mesh_provisioning: 0x1827,
  mesh_proxy: 0x1828,
  reboot: 0x1829,
  insulin_delivery: 0x183a,
  binary_sensor: 0x183b,
  emergency_configuration: 0x183c,
  physical_activity_monitor: 0x183e,
  audio_input_control: 0x1843,
  volume_control: 0x1844,
  volume_offset_control: 0x1845,
  coordinated_set_identification: 0x1846,
  device_time: 0x1847,
  media_control: 0x1848,
  generic_media_control: 0x1849,
  constant_tone_extension: 0x184a,
  telephone_bearer: 0x184b,
  generic_telephone_bearer: 0x184c,
  microphone_control: 0x184d,
  audio_stream_control: 0x184e,
  broadcast_audio_scan: 0x184f,
  published_audio_capabilities: 0x1850,
  basic_audio_announcement: 0x1851,
  broadcast_audio_announcement: 0x1852,
  common_audio: 0x1853,
  hearing_access: 0x1854,
  telephony_and_media_audio: 0x1855,
  public_broadcast_announcement: 0x1856,
  electronic_shelf_label: 0x1857,
});

const CHARACTERISTICS = Object.freeze({
  device_name: 0x2a00,
  appearance: 0x2a01,
  peripheral_privacy_flag: 0x2a02,
  reconnection_address: 0x2a03,
  peripheral_preferred_connection_parameters: 0x2a04,
  service_changed: 0x2a05,
  alert_level: 0x2a06,
  tx_power_level: 0x2a07,
  date_time: 0x2a08,
  day_of_week: 0x2a09,
  day_date_time: 0x2a0a,
  exact_time_256: 0x2a0c,
  dst_offset: 0x2a0d,
  time_zone: 0x2a0e,
  local_time_information: 0x2a0f,
  time_with_dst: 0x2a11,
  time_accuracy: 0x2a12,
  time_source: 0x2a13,
  reference_time_information: 0x2a14,
  time_update_control_point: 0x2a16,
  time_update_state: 0x2a17,
  glucose_measurement: 0x2a18,
  battery_level: 0x2a19,
  temperature_measurement: 0x2a1c,
  temperature_type: 0x2a1d,
  intermediate_temperature: 0x2a1e,
  measurement_interval: 0x2a21,
  boot_keyboard_input_report: 0x2a22,
  system_id: 0x2a23,
  model_number_string: 0x2a24,
  serial_number_string: 0x2a25,
  firmware_revision_string: 0x2a26,
  hardware_revision_string: 0x2a27,
  software_revision_string: 0x2a28,
  manufacturer_name_string: 0x2a29,
  ieee_11073_20601_regulatory_certification_data_list: 0x2a2a,
  current_time: 0x2a2b,
  magnetic_declination: 0x2a2c,
  scan_refresh: 0x2a31,
  boot_keyboard_output_report: 0x2a32,
  boot_mouse_input_report: 0x2a33,
  glucose_measurement_context: 0x2a34,
  blood_pressure_measurement: 0x2a35,
  intermediate_cuff_pressure: 0x2a36,
  heart_rate_measurement: 0x2a37,
  body_sensor_location: 0x2a38,
  heart_rate_control_point: 0x2a39,
  humidity: 0x2a6f,
  pressure: 0x2a6d,
  temperature: 0x2a6e,
  weight_measurement: 0x2a9d,
  weight_scale_feature: 0x2a9e,
  user_control_point: 0x2a9f,
  magnetic_flux_density_2d: 0x2aa0,
  magnetic_flux_density_3d: 0x2aa1,
  ln_feature: 0x2a6a,
  position_quality: 0x2a69,
  location_and_speed: 0x2a67,
  navigation: 0x2a68,
  elevation: 0x2a6c,
  true_wind_speed: 0x2a70,
  true_wind_direction: 0x2a71,
  apparent_wind_speed: 0x2a72,
  apparent_wind_direction: 0x2a73,
  gust_factor: 0x2a74,
  pollen_concentration: 0x2a75,
  uv_index: 0x2a76,
  irradiance: 0x2a77,
  rainfall: 0x2a78,
  wind_chill: 0x2a79,
  heat_index: 0x2a7a,
  dew_point: 0x2a7b,
  descriptor_value_changed: 0x2a7d,
  aerobic_heart_rate_lower_limit: 0x2a7e,
  aerobic_threshold: 0x2a7f,
  age: 0x2a80,
  anaerobic_heart_rate_lower_limit: 0x2a81,
  anaerobic_heart_rate_upper_limit: 0x2a82,
  anaerobic_threshold: 0x2a83,
  aerobic_heart_rate_upper_limit: 0x2a84,
  date_of_birth: 0x2a85,
  date_of_threshold_assessment: 0x2a86,
  email_address: 0x2a87,
  fat_burn_heart_rate_lower_limit: 0x2a88,
  fat_burn_heart_rate_upper_limit: 0x2a89,
  first_name: 0x2a8a,
  five_zone_heart_rate_limits: 0x2a8b,
  gender: 0x2a8c,
  heart_rate_max: 0x2a8d,
  height: 0x2a8e,
  hip_circumference: 0x2a8f,
  last_name: 0x2a90,
  maximum_recommended_heart_rate: 0x2a91,
  resting_heart_rate: 0x2a92,
  sport_type_for_aerobic_and_anaerobic_thresholds: 0x2a93,
  three_zone_heart_rate_limits: 0x2a94,
  two_zone_heart_rate_limits: 0x2a95,
  vo2_max: 0x2a96,
  waist_circumference: 0x2a97,
  weight: 0x2a98,
  database_change_increment: 0x2a99,
  user_index: 0x2a9a,
  body_composition_feature: 0x2a9b,
  body_composition_measurement: 0x2a9c,
  report_map: 0x2a4b,
  hid_control_point: 0x2a4c,
  hid_information: 0x2a4a,
  protocol_mode: 0x2a4e,
  report: 0x2a4d,
  pnp_id: 0x2a50,
  cycling_power_measurement: 0x2a63,
  cycling_power_feature: 0x2a65,
  cycling_power_vector: 0x2a64,
  cycling_power_control_point: 0x2a66,
  csc_measurement: 0x2a5b,
  csc_feature: 0x2a5c,
  sensor_location: 0x2a5d,
  sc_control_point: 0x2a55,
  rsc_measurement: 0x2a53,
  rsc_feature: 0x2a54,
  alert_status: 0x2a3f,
  ringer_control_point: 0x2a40,
  ringer_setting: 0x2a41,
  alert_category_id_bit_mask: 0x2a42,
  alert_category_id: 0x2a43,
  alert_notification_control_point: 0x2a44,
  unread_alert_status: 0x2a45,
  new_alert: 0x2a46,
  supported_new_alert_category: 0x2a47,
  supported_unread_alert_category: 0x2a48,
  blood_pressure_feature: 0x2a49,
  glucose_feature: 0x2a51,
  record_access_control_point: 0x2a52,
});

const DESCRIPTORS = Object.freeze({
  gatt_characteristic_extended_properties: 0x2900,
  gatt_characteristic_user_description: 0x2901,
  gatt_client_characteristic_configuration: 0x2902,
  gatt_server_characteristic_configuration: 0x2903,
  gatt_characteristic_presentation_format: 0x2904,
  gatt_characteristic_aggregate_format: 0x2905,
  valid_range: 0x2906,
  external_report_reference: 0x2907,
  report_reference: 0x2908,
  number_of_digitals: 0x2909,
  value_trigger_setting: 0x290a,
  environmental_sensing_configuration: 0x290b,
  environmental_sensing_measurement: 0x290c,
  environmental_sensing_trigger_setting: 0x290d,
  time_trigger_setting: 0x290e,
});

function fail(name, message) {
  return new DOMException(message, name);
}

function invalid(field, value) {
  return new TypeError(`invalid ${field}: ${JSON.stringify(value)}`);
}

const whole = (value, least) => Number.isInteger(value) && value >= least;

function parsed(tag) {
  try {
    return JSON.parse(tag);
  } catch {
    return null;
  }
}

function tagsOf(stamp) {
  return [stamp?.tag, ...(stamp?.tags ?? [])].filter((tag) => typeof tag === 'string').map(parsed);
}

export function typed(stamp) {
  const tags = tagsOf(stamp);
  return (
    tags.length > 0 &&
    tags.every(
      (tag) =>
        tag?.kind === 'user' && typeof tag.where === 'string' && tag.where.startsWith('terminal:')
    )
  );
}

export function asker(stamp) {
  const agent = tagsOf(stamp).find((tag) => tag?.kind === 'agent');
  if (!agent) return 'A program';
  return typeof agent.agentId === 'string' ? `The agent ${agent.agentId}` : 'The agent';
}

function aborted(signal) {
  const reason = signal.reason;
  if (reason?.name === 'AbortError') return reason;
  return fail('AbortError', String(reason?.message ?? reason));
}

function race(promise, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(aborted(signal));
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', stop));
  });
}

function off(enabled, registry, seen) {
  return !enabled() || registry.epoch !== seen;
}

function refuse() {
  throw fail('NotAllowedError', OFF);
}

function shortUuid(value) {
  return `${BASE.slice(0, 4)}${value.toString(16).padStart(4, '0')}${BASE.slice(8)}`.toLowerCase();
}

function aliasUuid(name, table) {
  const code = table[name];
  if (code === undefined) return null;
  return shortUuid(code);
}

export function uuidOf(value, kind = 'service') {
  const table =
    kind === 'characteristic' ? CHARACTERISTICS : kind === 'descriptor' ? DESCRIPTORS : SERVICES;
  if (typeof value === 'number') {
    if (!whole(value, 0) || value > 0xffffffff) throw invalid(kind, value);
    if (value <= 0xffff) return shortUuid(value);
    return `${value.toString(16).padStart(8, '0')}-0000-1000-8000-00805f9b34fb`.toLowerCase();
  }
  if (typeof value !== 'string') throw invalid(kind, value);
  const trimmed = value.trim();
  if (!trimmed) throw invalid(kind, value);
  if (FULL.test(trimmed)) return trimmed.toLowerCase();
  if (/^0x[0-9a-f]+$/i.test(trimmed) || /^[0-9a-f]+$/i.test(trimmed)) {
    const n = Number.parseInt(trimmed.replace(/^0x/i, ''), 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw invalid(kind, value);
    if (n <= 0xffff) return shortUuid(n);
    return `${n.toString(16).padStart(8, '0')}-0000-1000-8000-00805f9b34fb`.toLowerCase();
  }
  const aliased = aliasUuid(trimmed, table);
  if (aliased) return aliased;
  throw invalid(kind, value);
}

function uuidList(values, kind) {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw invalid(kind, values);
  return values.map((value) => uuidOf(value, kind === 'optionalServices' ? 'service' : kind));
}

function filtersOf(filters = []) {
  if (!Array.isArray(filters)) throw invalid('filters', filters);
  return filters.map((filter) => {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter))
      throw invalid('filters', filters);
    const out = {};
    for (const [key, value] of Object.entries(filter)) {
      if (key === 'services') {
        const list = uuidList(value, 'services');
        if (!list?.length) throw invalid('services', value);
        out.services = list;
      } else if (key === 'name' || key === 'namePrefix') {
        if (typeof value !== 'string' || !value) throw invalid(key, value);
        out[key] = value;
      } else throw invalid('filters', filters);
    }
    return out;
  });
}

function requestOptions(options) {
  const out = {};
  if (options.filters !== undefined) out.filters = filtersOf(options.filters);
  if (options.acceptAllDevices !== undefined) {
    if (typeof options.acceptAllDevices !== 'boolean')
      throw invalid('acceptAllDevices', options.acceptAllDevices);
    out.acceptAllDevices = options.acceptAllDevices;
  }
  if (options.optionalServices !== undefined)
    out.optionalServices = uuidList(options.optionalServices, 'optionalServices') ?? [];
  if (out.acceptAllDevices) {
    if (out.filters?.length) throw invalid('filters', options.filters);
  } else if (!out.filters?.length) {
    throw new TypeError('ble.request needs filters or acceptAllDevices');
  }
  return out;
}

function charKey(service, characteristic) {
  return `${uuidOf(service, 'service')}:${uuidOf(characteristic, 'characteristic')}`;
}

function valueBytes(view) {
  if (!view) return new Uint8Array(0);
  if (view instanceof ArrayBuffer) return new Uint8Array(view);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function propertiesOf(characteristic) {
  const props = characteristic.properties ?? {};
  const out = {};
  for (const key of [
    'broadcast',
    'read',
    'writeWithoutResponse',
    'write',
    'notify',
    'indicate',
    'authenticatedSignedWrites',
    'reliableWrite',
    'writableAuxiliaries',
  ]) {
    if (props[key]) out[key] = true;
  }
  return out;
}

function info(entry) {
  const out = {
    handle: entry.handle,
    id: entry.id,
    connected: entry.connected,
  };
  if (entry.name) out.name = entry.name;
  if (entry.services) out.services = entry.services;
  return out;
}

function blank(handle, device) {
  return {
    handle,
    device,
    id: device.id,
    name: device.name ?? '',
    gone: false,
    connected: false,
    ended: null,
    closing: null,
    connecting: null,
    closes: 0,
    notifiers: new Map(),
    halts: new Map(),
    lingering: new Set(),
    busy: new Set(),
    services: null,
  };
}

function makeRegistry() {
  const entries = new Map();
  const byDevice = new Map();
  const byId = new Map();
  const watchers = new Set();
  const heard = new WeakSet();
  let count = 0;
  const registry = {
    entries,
    watchers,
    epoch: 0,
    emit(event) {
      for (const watcher of watchers) {
        try {
          watcher(event);
        } catch {}
      }
    },
    listed: () => [...entries.values()].filter((entry) => !entry.gone),
    adopt(device, { reclaim = true } = {}) {
      let entry = byDevice.get(device);
      if (entry) {
        if (entry.gone) entry.gone = false;
        entry.name = device.name ?? entry.name;
        return entry;
      }
      const id = device.id;
      entry = id ? byId.get(id) : undefined;
      if (entry?.gone && !entry.connected && reclaim) {
        byDevice.delete(entry.device);
        entry.device = device;
        entry.gone = false;
        entry.name = device.name ?? entry.name;
        byDevice.set(device, entry);
        hearDevice(registry, entry);
        return entry;
      }
      if (entry && !entry.gone) {
        byDevice.delete(entry.device);
        entry.device = device;
        entry.name = device.name ?? entry.name;
        byDevice.set(device, entry);
        hearDevice(registry, entry);
        return entry;
      }
      count += 1;
      entry = blank(`ble${count}`, device);
      entries.set(entry.handle, entry);
      byDevice.set(device, entry);
      if (id) byId.set(id, entry);
      hearDevice(registry, entry);
      return entry;
    },
    listen(bluetooth) {
      if (heard.has(bluetooth)) return;
      heard.add(bluetooth);
    },
    async sync(bluetooth) {
      registry.listen(bluetooth);
      if (typeof bluetooth.getDevices !== 'function') return;
      const devices = await bluetooth.getDevices();
      for (const device of devices) registry.adopt(device);
      for (const entry of entries.values()) {
        if (!entry.gone && !entry.connected && !devices.includes(entry.device)) entry.gone = true;
      }
    },
    lookup(handle) {
      const entry = typeof handle === 'string' ? entries.get(handle) : undefined;
      if (!entry) throw fail('NotFoundError', `unknown ble handle '${String(handle ?? '')}'`);
      if (entry.gone && !entry.connected)
        throw fail('InvalidStateError', `${entry.handle} was disconnected`);
      return entry;
    },
  };
  return registry;
}

function hearDevice(registry, entry) {
  const { device } = entry;
  if (entry.heard === device) return;
  entry.heard = device;
  device.addEventListener('gattserverdisconnected', () => {
    if (!entry.connected) return;
    shut(registry, entry, 'unplugged');
  });
}

function shutError(entry) {
  if (entry.ended === 'seven')
    return fail('InvalidStateError', `${entry.handle} was closed in seven`);
  if (entry.ended === 'unplugged')
    return fail('InvalidStateError', `${entry.handle} was disconnected`);
  return fail(
    'InvalidStateError',
    `${entry.handle} is not connected (ble connect ${entry.handle})`
  );
}

function charBusy(entry, key) {
  if (entry.busy.has(key) || entry.notifiers.has(key) || entry.halts.has(key))
    throw fail('NoModificationAllowedError', `another operation is in progress on ${key}`);
}

async function releaseDevice(entry) {
  const gatt = entry.device.gatt;
  try {
    if (gatt?.connected) gatt.disconnect();
  } catch {}
}

function stopNotifiers(entry, why) {
  for (const stop of [...entry.notifiers.values()]) {
    try {
      stop(why);
    } catch {}
  }
  entry.notifiers.clear();
}

function mayHaltNotify(entry, key, stopNotify) {
  const cur = entry.notifiers.get(key);
  return cur === undefined || cur === stopNotify;
}

function shut(registry, entry, why) {
  if (!entry.connected && !entry.connecting && entry.notifiers.size === 0)
    return entry.closing ?? Promise.resolve();
  const hadConnected = entry.connected;
  entry.closes += 1;
  entry.connected = false;
  entry.ended = why;
  entry.services = null;
  stopNotifiers(entry, why);
  const connecting = entry.connecting;
  entry.connecting = null;
  entry.closing = (async () => {
    if (connecting) {
      try {
        await connecting;
      } catch {}
    }
    await releaseDevice(entry);
    entry.connected = false;
    entry.closing = null;
    registry.emit({ type: 'close', handle: entry.handle, why });
  })();
  if (connecting && !hadConnected) return Promise.resolve();
  return entry.closing;
}

async function connect(registry, entry, stamp, enabled) {
  const closeSeen = entry.closes;
  const seen = registry.epoch;
  if (entry.closing && entry.closes === closeSeen) await entry.closing;
  if (off(enabled, registry, seen)) refuse();
  if (entry.closes !== closeSeen) throw shutError(entry);
  if (entry.connected) {
    if (entry.device.gatt?.connected) return;
    entry.connected = false;
  }
  const gatt = entry.device.gatt;
  if (!gatt) throw fail('NetworkError', `${entry.handle} has no GATT server`);
  try {
    await gatt.connect();
  } catch (error) {
    if (adapterDown(error)) throw fail('NotSupportedError', MISSING);
    if (error?.name === 'NetworkError') throw error;
    throw error;
  }
  if (off(enabled, registry, seen)) {
    await releaseDevice(entry);
    refuse();
  }
  if (entry.closes !== closeSeen) {
    await releaseDevice(entry);
    throw shutError(entry);
  }
  entry.connected = true;
  entry.ended = null;
  entry.name = entry.device.name ?? entry.name;
  registry.emit({
    type: 'open',
    handle: entry.handle,
    info: info(entry),
    stamp,
    since: Date.now(),
  });
}

function beginConnect(registry, entry, stamp, enabled) {
  if (entry.connecting) return entry.connecting;
  let settle;
  const flight = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  entry.connecting = flight;
  connect(registry, entry, stamp, enabled).then(
    (value) => {
      if (entry.connecting === flight) entry.connecting = null;
      settle.resolve(value);
    },
    (error) => {
      if (entry.connecting === flight) entry.connecting = null;
      settle.reject(error);
    }
  );
  return flight;
}

async function ensureConnected(registry, entry, stamp, enabled) {
  if (entry.connected && entry.device.gatt?.connected) return;
  await beginConnect(registry, entry, stamp, enabled);
}

function adapterDown(error) {
  const message = String(error?.message ?? '');
  return (
    error?.name === 'NetworkError' &&
    /adapter|Bluetooth adapter not available|Bluetooth is not available/i.test(message)
  );
}

function mapGattError(error, service) {
  if (adapterDown(error)) return fail('NotSupportedError', MISSING);
  const message = String(error?.message ?? error);
  if (error?.name === 'NotAllowedError' && /\(add --service /.test(message)) return error;
  if (
    error?.name === 'SecurityError' ||
    error?.name === 'NotFoundError' ||
    /optionalServices|Origin is not allowed to access/i.test(message)
  ) {
    const hint = service === undefined ? '<uuid>' : String(service);
    return fail('NotAllowedError', `${message.replace(/\s+$/, '')} (add --service ${hint})`);
  }
  if (error?.name === 'NotAllowedError') return error;
  if (error?.name === 'NetworkError') return error;
  return error;
}

async function gather(reader, signal) {
  const chunks = [];
  let count = 0;
  for (;;) {
    const { value, done } = await race(reader.read(), signal);
    if (done) return { chunks, count };
    if (!value?.byteLength) continue;
    count += value.byteLength;
    if (count > LIMIT) throw fail('QuotaExceededError', 'a BLE write is at most 512 bytes');
    chunks.push(value);
  }
}

function joined(chunks, count) {
  const out = new Uint8Array(count);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function primaryService(entry, service, signal) {
  try {
    return await race(entry.device.gatt.getPrimaryService(uuidOf(service, 'service')), signal);
  } catch (error) {
    throw mapGattError(error, service);
  }
}

async function characteristicOf(entry, service, characteristic, signal) {
  const svc = await primaryService(entry, service, signal);
  try {
    return await race(svc.getCharacteristic(uuidOf(characteristic, 'characteristic')), signal);
  } catch (error) {
    throw mapGattError(error, service);
  }
}

async function describeServices(entry, signal) {
  let services;
  try {
    services = await race(entry.device.gatt.getPrimaryServices(), signal);
  } catch (error) {
    throw mapGattError(error);
  }
  const out = [];
  for (const service of services) {
    let characteristics = [];
    try {
      characteristics = await race(service.getCharacteristics(), signal);
    } catch (error) {
      throw mapGattError(error, service.uuid);
    }
    const chars = [];
    for (const characteristic of characteristics) {
      let descriptors = [];
      try {
        descriptors = await race(characteristic.getDescriptors(), signal);
      } catch {
        descriptors = [];
      }
      chars.push({
        uuid: characteristic.uuid,
        properties: propertiesOf(characteristic),
        descriptors: descriptors.map((descriptor) => ({ uuid: descriptor.uuid })),
      });
    }
    out.push({ uuid: service.uuid, characteristics: chars });
  }
  entry.services = out;
  return out;
}

async function readValue(registry, entry, options, signal, enabled, stamp) {
  const service = options.service;
  const characteristic = options.characteristic;
  if (service === undefined) throw invalid('service', service);
  if (characteristic === undefined) throw invalid('characteristic', characteristic);
  const seen = registry.epoch;
  await ensureConnected(registry, entry, stamp, enabled);
  if (off(enabled, registry, seen)) refuse();
  if (!entry.connected) throw shutError(entry);
  const key = charKey(service, characteristic);
  charBusy(entry, key);
  entry.busy.add(key);
  try {
    const char = await characteristicOf(entry, service, characteristic, signal);
    if (off(enabled, registry, seen)) refuse();
    if (!entry.connected) throw shutError(entry);
    let view;
    if (options.descriptor !== undefined) {
      let descriptor;
      try {
        descriptor = await race(
          char.getDescriptor(uuidOf(options.descriptor, 'descriptor')),
          signal
        );
      } catch (error) {
        throw mapGattError(error, service);
      }
      view = await race(descriptor.readValue(), signal);
    } else {
      view = await race(char.readValue(), signal);
    }
    if (off(enabled, registry, seen)) refuse();
    if (!entry.connected) throw shutError(entry);
    const bytes = valueBytes(view);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  } catch (error) {
    if (off(enabled, registry, seen)) refuse();
    if (!entry.connected) throw shutError(entry);
    throw mapGattError(error, service);
  } finally {
    entry.busy.delete(key);
  }
}

async function writeValue(registry, entry, options, body, signal, enabled, stamp) {
  const service = options.service;
  const characteristic = options.characteristic;
  if (service === undefined) throw invalid('service', service);
  if (characteristic === undefined) throw invalid('characteristic', characteristic);
  if (options.noResponse !== undefined && typeof options.noResponse !== 'boolean')
    throw invalid('noResponse', options.noResponse);
  const seen = registry.epoch;
  await ensureConnected(registry, entry, stamp, enabled);
  if (off(enabled, registry, seen)) refuse();
  if (!entry.connected) throw shutError(entry);
  const key = charKey(service, characteristic);
  charBusy(entry, key);
  entry.busy.add(key);
  const reader = body.getReader();
  try {
    const { chunks, count } = await gather(reader, signal);
    if (off(enabled, registry, seen)) refuse();
    if (!entry.connected) throw shutError(entry);
    const bytes = joined(chunks, count);
    const char = await characteristicOf(entry, service, characteristic, signal);
    if (off(enabled, registry, seen)) refuse();
    if (!entry.connected) throw shutError(entry);
    const op = options.noResponse
      ? char.writeValueWithoutResponse.bind(char)
      : char.writeValueWithResponse.bind(char);
    await race(op(bytes), signal);
    if (off(enabled, registry, seen)) refuse();
    if (!entry.connected) throw shutError(entry);
  } catch (error) {
    await Promise.allSettled([reader.cancel()]);
    if (off(enabled, registry, seen)) refuse();
    if (!entry.connected) throw shutError(entry);
    throw mapGattError(error, service);
  } finally {
    entry.busy.delete(key);
  }
}

async function haltNotify(char) {
  if (!char) return;
  try {
    await char.stopNotifications();
  } catch {}
}

function trackHalt(entry, key, char) {
  const halt = haltNotify(char);
  entry.halts.set(key, halt);
  const forget = () => {
    if (entry.halts.get(key) === halt) entry.halts.delete(key);
  };
  const record = { char, halt };
  if (char) entry.lingering.add(record);
  void halt.finally(() => {
    forget();
    entry.lingering.delete(record);
  });
  setTimeout(forget, HALT_BUSY_MS);
  return halt;
}

function haltsOn(entry, char) {
  return [...entry.lingering].filter((record) => record.char === char).map((r) => r.halt);
}

async function runHalt(entry, key, char, stopNotify) {
  if (!mayHaltNotify(entry, key, stopNotify)) return;
  await trackHalt(entry, key, char);
}

export function notifyBlocked(over, enabled, registry, seen, entry, failNotify) {
  if (over) return true;
  if (off(enabled, registry, seen)) {
    failNotify(fail('NotAllowedError', OFF));
    return true;
  }
  if (!entry.connected) {
    failNotify(shutError(entry));
    return true;
  }
  return false;
}

async function settleNotifyStart(
  char,
  over,
  enabled,
  registry,
  seen,
  entry,
  failNotify,
  key,
  stopNotify
) {
  if (!(over || off(enabled, registry, seen) || !entry.connected)) return false;
  await runHalt(entry, key, char, stopNotify);
  notifyBlocked(over, enabled, registry, seen, entry, failNotify);
  return true;
}

function notify(registry, entry, options, signal, enabled, stamp, progress) {
  const service = options.service;
  const characteristic = options.characteristic;
  if (service === undefined) throw invalid('service', service);
  if (characteristic === undefined) throw invalid('characteristic', characteristic);
  const key = charKey(service, characteristic);
  charBusy(entry, key);
  const seen = registry.epoch;
  let over = false;
  let controller;
  let char;
  let stopNotify;
  let flight = null;
  let starting = null;
  let dropped = 0;
  let quiet = null;
  const announce = () => {
    if (!progress || quiet || !dropped) return;
    progress(`${entry.handle}: ${dropped} values dropped (nobody read in time)`);
    dropped = 0;
    quiet = setTimeout(() => {
      quiet = null;
      announce();
    }, QUIET);
  };
  const onValue = (event) => {
    if (over || !controller) return;
    const bytes = valueBytes(event.target?.value ?? event.value);
    if (bytes.byteLength === 0) return;
    if ((controller.desiredSize ?? 0) <= 0) {
      dropped += 1;
      announce();
      return;
    }
    try {
      controller.enqueue(bytes);
    } catch {}
  };
  const done = () => {
    if (flight !== null) return flight;
    over = true;
    clearTimeout(quiet);
    quiet = null;
    signal.removeEventListener('abort', onAbort);
    flight = (async () => {
      if (char) char.removeEventListener('characteristicvaluechanged', onValue);
      if (starting) await Promise.allSettled([starting]);
      await runHalt(entry, key, char, stopNotify);
      if (entry.notifiers.get(key) === stopNotify) entry.notifiers.delete(key);
    })();
    return flight;
  };
  const failNotify = (error) => {
    if (over) return;
    void done();
    try {
      controller?.error(error);
    } catch {}
  };
  stopNotify = (why) => {
    entry.ended = why ?? entry.ended;
    if (off(enabled, registry, seen)) return failNotify(fail('NotAllowedError', OFF));
    return failNotify(shutError(entry));
  };
  const rearm = async (behind) => {
    await Promise.allSettled(behind);
    if (over) return;
    const again = char.startNotifications();
    starting = again;
    try {
      await again;
    } catch (error) {
      failNotify(mapGattError(error, service));
    }
  };
  const onAbort = () => {
    void done().then(() => {
      try {
        controller?.close();
      } catch {}
    });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  entry.notifiers.set(key, stopNotify);
  return new ReadableStream(
    {
      async start(ctrl) {
        controller = ctrl;
        try {
          await ensureConnected(registry, entry, stamp, enabled);
          if (notifyBlocked(over, enabled, registry, seen, entry, failNotify)) return;
          char = await characteristicOf(entry, service, characteristic, signal);
          if (notifyBlocked(over, enabled, registry, seen, entry, failNotify)) return;
          char.addEventListener('characteristicvaluechanged', onValue);
          const behind = haltsOn(entry, char);
          const start = char.startNotifications();
          starting = start;
          try {
            await race(start, signal);
          } catch (error) {
            await Promise.allSettled([start]);
            await runHalt(entry, key, char, stopNotify);
            if (!over) failNotify(mapGattError(error, service));
            return;
          }
          if (
            await settleNotifyStart(
              char,
              over,
              enabled,
              registry,
              seen,
              entry,
              failNotify,
              key,
              stopNotify
            )
          )
            return;
          if (behind.length > 0) void rearm(behind);
        } catch (error) {
          return failNotify(mapGattError(error, service));
        }
      },
      pull() {
        if (over) return;
        if (off(enabled, registry, seen)) return failNotify(fail('NotAllowedError', OFF));
      },
      cancel() {
        return done();
      },
    },
    { highWaterMark: NOTIFY_BUFFER }
  );
}

async function request(registry, bluetooth, options, signal, enabled) {
  const wanted = requestOptions(options);
  const seen = registry.epoch;
  let device;
  try {
    device = await race(bluetooth.requestDevice(wanted), signal);
  } catch (error) {
    if (adapterDown(error)) throw fail('NotSupportedError', MISSING);
    if (error?.name === 'NotFoundError') throw fail('NotAllowedError', CANCELLED);
    if (error?.name === 'SecurityError') throw fail('NotAllowedError', UNCLICKED);
    throw error;
  }
  if (off(enabled, registry, seen)) refuse();
  return JSON.stringify(info(registry.adopt(device, { reclaim: false })));
}

async function services(registry, entry, stamp, enabled, signal) {
  const seen = registry.epoch;
  await ensureConnected(registry, entry, stamp, enabled);
  if (off(enabled, registry, seen)) refuse();
  if (!entry.connected) throw shutError(entry);
  const listed = await describeServices(entry, signal);
  if (off(enabled, registry, seen)) refuse();
  if (!entry.connected) throw shutError(entry);
  return JSON.stringify(listed);
}

function answer(registry, bluetooth, asked, enabled) {
  const { kind, options, body, stamp, signal, progress } = asked;
  if (kind === 'ble.list') return JSON.stringify(registry.listed().map(info));
  if (kind === 'ble.request') return request(registry, bluetooth, options, signal, enabled);
  const entry = registry.lookup(options.handle);
  if (kind === 'ble.disconnect') return shut(registry, entry, 'closed');
  if (kind === 'ble.connect') return beginConnect(registry, entry, stamp, enabled);
  if (kind === 'ble.services') return services(registry, entry, stamp, enabled, signal);
  if (kind === 'ble.read') return readValue(registry, entry, options, signal, enabled, stamp);
  if (kind === 'ble.notify')
    return notify(registry, entry, options, signal, enabled, stamp, progress);
  return writeValue(registry, entry, options, body, signal, enabled, stamp);
}

function prompt(stamp) {
  return {
    title: 'Choose a Bluetooth device',
    body: `${asker(stamp)} wants to use a Bluetooth device. Click Choose, then pick it in the browser's list.`,
    action: 'Choose…',
    cancel: 'Cancel',
    variant: 'confirmation',
    dismissed: CANCELLED,
    late: LATE,
  };
}

export function create(overrides = {}) {
  const env = (name) => (Object.hasOwn(overrides, name) ? overrides[name] : globalThis[name]);
  const enabled = overrides.enabled ?? (() => true);
  const active = () => env('navigator')?.userActivation?.isActive === true;
  const registry = makeRegistry();

  function api() {
    const bluetooth = env('navigator')?.bluetooth;
    if (!bluetooth) throw fail('NotSupportedError', MISSING);
    return bluetooth;
  }

  async function handle({
    kind,
    options = {},
    body,
    stamp,
    signal = new AbortController().signal,
    progress,
  }) {
    if (!Object.hasOwn(kinds, kind))
      throw fail('NotSupportedError', `slicc-devices does not answer ${kind}`);
    if (!enabled()) refuse();
    const bluetooth = api();
    const seen = registry.epoch;
    await registry.sync(bluetooth);
    if (off(enabled, registry, seen)) refuse();
    return answer(registry, bluetooth, { kind, options, body, stamp, signal, progress }, enabled);
  }

  const prompts = {
    'ble.request': (asked) => {
      if (!enabled() || !env('navigator')?.bluetooth) return null;
      if (typed(asked.stamp) && active()) return null;
      asked.progress?.(WAITING);
      return prompt(asked.stamp);
    },
  };

  const ble = {
    list: () => registry.listed().map(info),
    close: async (handle) => {
      const entry = registry.entries.get(handle);
      if (entry && (entry.connected || entry.connecting || entry.notifiers.size))
        await shut(registry, entry, 'seven');
    },
    closeAll: async () => {
      registry.epoch += 1;
      for (const entry of registry.entries.values()) await shut(registry, entry, 'seven');
    },
    watch(listener) {
      registry.watchers.add(listener);
      return () => registry.watchers.delete(listener);
    },
  };

  return { kinds, prompts, ble, handle };
}
