const assert = require('chai').assert;
const pluginFactory = require('../index.js');

describe('RaceBox Protocol Parser', () => {
  let app;
  let plugin;
  let lastDelta;

  beforeEach(() => {
    lastDelta = null;
    app = {
      debug: () => {},
      setProviderStatus: () => {},
      handleMessage: (id, delta) => {
        lastDelta = delta;
      }
    };
    plugin = pluginFactory(app);
  });

  it('should identify as signalk-racebox-imu', () => {
    assert.equal(plugin.id, 'signalk-racebox-imu');
  });

  it('should have start and stop functions', () => {
    assert.isFunction(plugin.start);
    assert.isFunction(plugin.stop);
  });

  it('should define a schema with experimental flags', () => {
    assert.property(plugin.schema.properties, 'enableWaveDetection');
    assert.property(plugin.schema.properties, 'slamThreshold');
  });

  it('should not crash when started without options', () => {
    // This tests the "Activates with defaults" requirement
    assert.doesNotThrow(() => {
      plugin.start({});
      plugin.stop();
    });
  });
});
