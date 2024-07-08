#!/bin/sh
#
apt update 
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do apt-get remove $pkg; done
apt upgrade -y
apt install -qy git jq ca-certificates curl gzip ipset screen vim bmon netdiag conntrack
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -qy docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
cat > /etc/ssh/sshd_config.d/xlr8d_opts.conf << XLR8D_EOF
Port 19198
XLR8D_EOF
DEFAULT_GW_INT=`netstat -rn | grep "^0\.0\.0\.0" | grep -o "\(\w*\)$"`
cat > /etc/iptables.conf << XLR8D_EOF
*raw
:PREROUTING ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
-A PREROUTING -i $DEFAULT_GW_INT -p tcp -m tcp --dport 19198 -j CT --notrack
-A PREROUTING -i $DEFAULT_GW_INT -p udp -m udp --sport 67 --dport 68 -j CT --notrack
-A OUTPUT -o $DEFAULT_GW_INT -p tcp -m tcp --sport 19198 -j CT --notrack
-A OUTPUT -o $DEFAULT_GW_INT -p udp -m udp --sport 68 --dport 67 -j CT --notrack
COMMIT
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DE - [0:0]
:permitICMP - [0:0]
:DOCKER-USER - [0:0]
-A INPUT -i lo -j ACCEPT
-A INPUT -i $DEFAULT_GW_INT -p udp -m udp --sport 67 --dport 68 -j ACCEPT
-A INPUT -i $DEFAULT_GW_INT -p tcp -m tcp --dport 19198 -j ACCEPT
-A INPUT -i $DEFAULT_GW_INT -m set --match-set allowed4hosts src -j ACCEPT
-A INPUT -i $DEFAULT_GW_INT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A INPUT -i $DEFAULT_GW_INT -j permitICMP
-A INPUT -j DE
-A FORWARD -i lo -j ACCEPT
-A FORWARD -i $DEFAULT_GW_INT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A FORWARD -i $DEFAULT_GW_INT -m set --match-set allowed4hosts src -j ACCEPT
-A FORWARD -j DE
-A DOCKER-USER -i $DEFAULT_GW_INT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A DOCKER-USER -i $DEFAULT_GW_INT -m set --match-set allowed4hosts src -j ACCEPT
-A DOCKER-USER -i $DEFAULT_GW_INT -j DE
-A DE -p tcp -j REJECT --reject-with tcp-reset
-A DE -p udp -j REJECT --reject-with icmp-port-unreachable
-A DE -j REJECT --reject-with icmp-proto-unreachable
-A permitICMP -p icmp -m icmp --icmp-type 3/1 -j ACCEPT
-A permitICMP -p icmp -m icmp --icmp-type 3/4 -j ACCEPT
-A permitICMP -p icmp -m icmp --icmp-type 8 -j ACCEPT
-A permitICMP -p icmp -m icmp --icmp-type 11/0 -j ACCEPT
-A permitICMP -p icmp -m icmp --icmp-type 30 -j ACCEPT
-A permitICMP -p icmp -j DROP
-A permitICMP -j RETURN
COMMIT
XLR8D_EOF

cat > /etc/ip6tables.conf << XLR8D_EOF
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:DOCKER-USER - [0:0]
:DE - [0:0]
-A INPUT -i lo -j ACCEPT
-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A INPUT -s fe80::/8 -d ff00::/8 -i $DEFAULT_GW_INT -p icmpv6 -j ACCEPT
-A INPUT -s fe80::/8 -i $DEFAULT_GW_INT -p icmpv6 -j ACCEPT
-A INPUT -i $DEFAULT_GW_INT -m set --match-set allowed6hosts src -j ACCEPT
-A INPUT -i $DEFAULT_GW_INT -p icmpv6 -j ACCEPT
-A INPUT -j DE
-A FORWARD -i lo -j ACCEPT
-A FORWARD -i $DEFAULT_GW_INT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A FORWARD -i $DEFAULT_GW_INT -m set --match-set allowed6hosts src -j ACCEPT
-A FORWARD -j DE
-A DOCKER-USER -i $DEFAULT_GW_INT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A DOCKER-USER -i $DEFAULT_GW_INT -m set --match-set allowed6hosts src -j ACCEPT
-A DOCKER-USER -i $DEFAULT_GW_INT -j DE
-A DE -p tcp -j REJECT --reject-with tcp-reset
-A DE -p udp -j REJECT --reject-with icmp6-port-unreachable
-A DE -j REJECT --reject-with icmp6-addr-unreachable
COMMIT
XLR8D_EOF

cat > /etc/rc.local << XLR8D_EOF
#!/bin/sh
#
# IPSETs
# v4
ipset create allowed4hosts hash:ip maxelem 1024 timeout 0 family inet
#ipset -! add allowed4hosts 217.61.104.24
# v6
ipset create allowed6hosts hash:ip maxelem 1024 timeout 0 family inet6
#ipset -! add allowed6hosts 2a03:a140:10:2c18::1
#
iptables-restore < /etc/iptables.conf
ip6tables-restore < /etc/ip6tables.conf
# RFC6890
ip route add blackhole 0.0.0.0/8
ip route add blackhole 10.0.0.0/8
#ip route add blackhole 100.64.0.0/10
#ip route add blackhole 127.0.0.0/8
ip route add blackhole 169.254.0.0/16
#ip route add blackhole 172.16.0.0/12
# split for docker gw_bridge autoassignee
ip route add blackhole 172.16.0.0/16
ip route add blackhole 172.19.0.0/16
ip route add blackhole 172.20.0.0/14
ip route add blackhole 172.24.0.0/13
#
ip route add blackhole 192.0.0.0/24
ip route add blackhole 192.0.2.0/24
ip route add blackhole 192.88.99.0/24
ip route add blackhole 192.168.0.0/16
ip route add blackhole 198.18.0.0/15
ip route add blackhole 198.51.100.0/24
ip route add blackhole 203.0.113.0/24
ip route add blackhole 224.0.0.0/4
ip route add blackhole 240.0.0.0/4
#
sysctl -f
#
exit 0
#
XLR8D_EOF
chmod +x /etc/rc.local
cat > /etc/sysctl.conf << XLR8D_EOF
net.ipv4.conf.default.rp_filter=1
net.ipv4.conf.all.rp_filter=1
net.ipv4.tcp_syncookies=1
net.ipv4.ip_forward=0
net.ipv6.conf.all.forwarding=1
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
vm.swappiness = 1
vm.vfs_cache_pressure = 1000
vm.dirty_background_ratio = 10
vm.dirty_ratio = 20
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.udp_mem = 8388608 12582912 16777216
net.ipv4.tcp_rmem = 4096 87380 8388608
net.ipv4.tcp_wmem = 4096 65536 8388608
net.core.wmem_default = 16777216
net.core.rmem_default = 16777216
net.ipv4.tcp_tw_reuse = 1
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.nf_conntrack_max=262144
net.core.somaxconn = 4096
XLR8D_EOF
sysctl -f
cat >> /etc/screenrc << XLR8D_EOF
screen -t notes 0 vim notes
screen -t bash 1 bash
screen -t bash 2 bash
screen -t bash 3 bash
screen -t sudo 4 sudo su -
screen -t mc 5 sudo mc -ba
screen -t sudo 6 sudo su -
screen -t bash 7 bash
screen -t sudo 8 sudo su -  
screen -t top 9 htop
caption always "%{=s gk}%d.%m.%Y%{+b i.} %0c %{=s y.}%-w%{+bu i.}%n %t%{-}%+w%<"
XLR8D_EOF
mkdir -p /srv/da_platform
chown -R adminroot /srv/da_platform
usermod -aG docker adminroot
