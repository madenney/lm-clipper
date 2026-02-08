// Jest mock for GpuLayer (uses import.meta.url for web workers)
const React = require('react')
function GpuLayer() { return React.createElement('div') }
module.exports = { GpuLayer, default: GpuLayer }
