resource "ah_ssh_key" "xlr8d-da-platform-dev-rsa" {
  name = "DA platform [dev]"
  public_key = file("../keys/dev-infra.rsa.pub")
}

resource "ah_cloud_server" "xlr8d-da-platform-dev" {
  name = "DA platform [dev]"
  datacenter = "ams1"
  image = "ubuntu-24_04-x64"
  plan = "start-xs"
  backups = false
  use_password = false
  depends_on = [ ah_ssh_key.xlr8d-da-platform-dev-rsa ]
  ssh_keys = [ ah_ssh_key.xlr8d-da-platform-dev-rsa.fingerprint ]
  create_public_ip_address = true
  private_cloud = false 
  connection {
    type     = "ssh"
    user     = "adminroot"
    port     = 22
    target_platform = "unix"
    private_key = file("../keys/dev-infra.rsa")
    host     = self.ips[0].ip_address
  }
  provisioner "remote-exec" {
    inline = [
      "mkdir -p /home/adminroot/.ssh"
    ]
  }
  provisioner "file" {
    source	= "../keys/repo-keys"
    destination = "/home/adminroot"
  }
  provisioner "file" {
    source      = "../keys/repo-keys/xlr8d-da-platform.pem"
    destination = "/home/adminroot/.ssh/id_rsa"
  }
  provisioner "file" {
    source      = "./provisioning/init.sh"
    destination = "/tmp/init.sh"
  }
    provisioner "file" {
    source      = "./provisioning/services.sh"
    destination = "/tmp/services.sh"
  }
  provisioner "remote-exec" {
    inline = [
      "chmod go-rwx /home/adminroot/.ssh/id_rsa",
      "chmod go-rwx /home/adminroot/repo-keys/*", 
      "chmod +x /tmp/init.sh",
      "sudo /tmp/init.sh",
      "chmod +x /tmp/services.sh",
      "/tmp/services.sh",
      "sudo reboot"
    ]
  }
}

output "server_params" {
  description = "Created server"
  value = [
    ah_cloud_server.xlr8d-da-platform-dev.created_at,
    ah_cloud_server.xlr8d-da-platform-dev.id,
    ah_cloud_server.xlr8d-da-platform-dev.state,
    ah_cloud_server.xlr8d-da-platform-dev.vcpu,
    ah_cloud_server.xlr8d-da-platform-dev.ram,
    ah_cloud_server.xlr8d-da-platform-dev.disk,
    ah_cloud_server.xlr8d-da-platform-dev.ips
  ]
}

resource "local_file" "running_servers" {
  filename = "./running.server.ip"
  content = ah_cloud_server.xlr8d-da-platform-dev.ips[0].ip_address
  depends_on = [ ah_cloud_server.xlr8d-da-platform-dev ]
}
