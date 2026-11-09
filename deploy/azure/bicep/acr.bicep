// Azure Container Registry for the app images (backend, dashboard) and the five
// sandbox images. Admin user is disabled; access is via AAD (CI uses OIDC, the
// VM uses its managed identity with the AcrPull role assigned in roles.bicep).

param location string
param acrName string

@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param sku string = 'Standard'

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  sku: {
    name: sku
  }
  properties: {
    adminUserEnabled: false
  }
}

output loginServer string = acr.properties.loginServer
output id string = acr.id
