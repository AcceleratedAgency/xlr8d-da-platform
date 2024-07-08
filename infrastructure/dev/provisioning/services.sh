#!/bin/sh
#
cd /home/adminroot
for key in `ls ./repo-keys/*.pem`; do
    REPO=`echo -n $key | sed 's/.*repo-keys\/\(.*\)\.pem$/\1/'`;
    cat >> .ssh/config << EOF
HOST $REPO
    HostName github.com
    User git
    IdentityFile ~/repo-keys/$REPO.pem

EOF
done;
GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new' git clone -b pontius git@github.com:AcceleratedAgency-com/xlr8d-da-platform.git /srv/da_platform
cd /srv/da_platform
sed -i 's/\(^\s*\t*url.*@\)\(github.com\)\(.*\/\)\(.*\)\(\.git$\)/\1\4\3\4\5/g' .gitmodules
git submodule update --init --recursive