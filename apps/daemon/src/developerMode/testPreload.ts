/**
 * Test preload: Daemons run from source by tests, in process or spawned, start with Developer
 * Mode's from-source term off, so suites don't trace themselves. A test may set it back (README.md).
 */
process.env.POLARIS_DEVELOPER_MODE ??= "off";
