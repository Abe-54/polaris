#!/bin/bash
set -u
INT=/Users/lucasdoell/code/polaris.worktrees/polaris/grill-with-docs-i-want-to-do-7ce3
(cd /tmp/pl-main && bun scripts/build-daemon.ts linux-arm64 >/tmp/g3pi/build-main.log 2>&1); echo build-main=$?
(cd $INT && bun scripts/build-daemon.ts linux-arm64 >/tmp/g3pi/build-head.log 2>&1); echo build-head=$?
SSH="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes lucas-rpi"
$SSH 'mkdir -p /tmp/g3pi/main /tmp/g3pi/head'
scp -q -o BatchMode=yes -o StrictHostKeyChecking=yes /tmp/pl-main/apps/daemon/dist/linux-arm64/polaris lucas-rpi:/tmp/g3pi/main/polaris
scp -q -o BatchMode=yes -o StrictHostKeyChecking=yes $INT/apps/daemon/dist/linux-arm64/polaris lucas-rpi:/tmp/g3pi/head/polaris
scp -q -o BatchMode=yes -o StrictHostKeyChecking=yes /tmp/g3pi/pi-idle.sh lucas-rpi:/tmp/g3pi/pi-idle.sh
for i in 1 2 3; do
  $SSH 'bash /tmp/g3pi/pi-idle.sh main /tmp/g3pi/main/polaris; bash /tmp/g3pi/pi-idle.sh head /tmp/g3pi/head/polaris'
done
$SSH 'uptime; rm -rf /tmp/g3pi'
