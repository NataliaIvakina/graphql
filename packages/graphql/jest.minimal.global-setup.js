// eslint-disable-next-line import/no-extraneous-dependencies
const setTZ = require("set-tz");

const TZ = "Etc/UTC";

module.exports = async function globalSetup() {
    process.env.NODE_ENV = "test";

    setTZ(TZ);
};
