terraform {
  required_providers {
    ah = {
      source = "advancedhosting/ah"
      version = "0.3.0"
    }
  }
}

provider "ah" {
  access_token = data.local_file.ah_api_key.content
}

data "local_file" "ah_api_key" {
  filename = "../keys/ah_api_key.private"
}

