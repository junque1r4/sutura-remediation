// =============================================================================
// Sutura -- Azure infrastructure (single Linux VM topology)
//
// Provisions: Azure Container Registry, Key Vault (RBAC), a hardened Ubuntu VM
// with a system-assigned managed identity, networking (VNet/subnet/NSG/public
// IP), and role assignments so the VM can pull from ACR and read Key Vault
// secrets with no stored credentials.
//
// Deploy:
//   az group create -n sutura-rg -l westeurope
//   az deployment group create -g sutura-rg \
//     -f deploy/azure/bicep/main.bicep \
//     -p @deploy/azure/parameters.example.json \
//     -p adminPublicKey="$(cat ~/.ssh/id_rsa.pub)"
// =============================================================================

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Short prefix for resource names (lowercase letters/numbers).')
@minLength(3)
@maxLength(11)
param namePrefix string = 'sutura'

@description('Admin username for the VM.')
param adminUsername string = 'sutura'

@description('SSH public key for the VM admin user.')
param adminPublicKey string

@description('CIDR/IP allowed to reach SSH (port 22). Use your office/VPN IP, e.g. 203.0.113.4/32.')
param adminSourceAddressPrefix string

@description('VM size. D4s_v5 (16 GB) is the minimum given the 6 GB sandbox memory cap; D8s_v5 for headroom.')
param vmSize string = 'Standard_D4s_v5'

@description('Premium SSD data disk size (GB) mounted at /var/lib/docker.')
param dataDiskSizeGB int = 128

@description('DNS label for the public IP FQDN (<label>.<region>.cloudapp.azure.com).')
param dnsLabelPrefix string

@description('Optional: AAD objectId of the human/SP that will seed Key Vault secrets (granted Key Vault Secrets Officer). Leave empty to skip.')
param deployerObjectId string = ''

var acrName = toLower('${namePrefix}acr${uniqueString(resourceGroup().id)}')
var keyVaultName = toLower('${namePrefix}kv${uniqueString(resourceGroup().id)}')

module network 'network.bicep' = {
  name: 'network'
  params: {
    location: location
    namePrefix: namePrefix
    dnsLabelPrefix: dnsLabelPrefix
    adminSourceAddressPrefix: adminSourceAddressPrefix
  }
}

module acr 'acr.bicep' = {
  name: 'acr'
  params: {
    location: location
    acrName: acrName
  }
}

module keyvault 'keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    keyVaultName: keyVaultName
    deployerObjectId: deployerObjectId
  }
}

module vm 'vm.bicep' = {
  name: 'vm'
  params: {
    location: location
    namePrefix: namePrefix
    vmSize: vmSize
    adminUsername: adminUsername
    adminPublicKey: adminPublicKey
    dataDiskSizeGB: dataDiskSizeGB
    subnetId: network.outputs.subnetId
    publicIpId: network.outputs.publicIpId
    networkSecurityGroupId: network.outputs.nsgId
  }
}

// Role assignments require the VM identity's principalId, so they run last.
module roles 'roles.bicep' = {
  name: 'roles'
  params: {
    acrName: acrName
    keyVaultName: keyVaultName
    principalId: vm.outputs.principalId
  }
  dependsOn: [
    acr
    keyvault
  ]
}

output acrLoginServer string = acr.outputs.loginServer
output acrName string = acrName
output keyVaultName string = keyVaultName
output vmName string = vm.outputs.vmName
output vmFqdn string = network.outputs.fqdn
output vmPublicIp string = network.outputs.publicIpAddress
