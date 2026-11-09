// Key Vault holding all Sutura runtime secrets. RBAC authorization mode (not
// access policies): the VM identity gets "Key Vault Secrets User" (read) via
// roles.bicep, and the optional deployer gets "Key Vault Secrets Officer"
// (read/write) here so a human/SP can seed the secrets.

param location string
param keyVaultName string
param deployerObjectId string = ''

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

// Key Vault Secrets Officer -- lets the named deployer create/update secrets.
var secretsOfficerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

resource deployerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerObjectId)) {
  name: guid(keyVault.id, deployerObjectId, secretsOfficerRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: secretsOfficerRoleId
    principalId: deployerObjectId
    principalType: 'User'
  }
}

output id string = keyVault.id
output name string = keyVault.name
output uri string = keyVault.properties.vaultUri
